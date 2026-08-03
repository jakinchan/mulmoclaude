// Debug plugin — server side. Experimental playground used as the
// integration bed for upcoming host features (the Notifier engine
// landed first; the Tasks + Chat runtime APIs land alongside this
// release as Phase 1 of the Encore plan). Loaded as a preset runtime
// plugin so it appears on every fresh checkout in dev mode.
//
// `node:fs` / `node:path` / `console` / direct `fetch` are unused —
// the gui-chat-protocol eslint preset bans them at lint time.
//
// The notifier / tasks / chat dispatches below assume a
// MulmoClaude-augmented runtime that exposes those host extensions
// over `gui-chat-protocol`'s `PluginRuntime`. The cast is the
// contract — once the API stabilises and lands in
// `gui-chat-protocol`, the cast goes away.

import { definePlugin, type PluginRuntime } from "gui-chat-protocol";
import { z } from "zod";
import { TOOL_DEFINITION } from "./definition";

export { TOOL_DEFINITION };

const NotifierSeverity = z.enum(["info", "nudge", "urgent"]);
const NotifierLifecycle = z.enum(["fyi", "action"]);

const Args = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("echo"), message: z.string() }),
  z.object({
    kind: z.literal("publish"),
    severity: NotifierSeverity,
    lifecycle: NotifierLifecycle,
    title: z.string().min(1),
    body: z.string().optional(),
    navigateTarget: z.string().optional(),
  }),
  z.object({ kind: z.literal("clear"), id: z.string().min(1) }),
  z.object({
    kind: z.literal("chat-start"),
    initialMessage: z.string().min(1),
    role: z.string().optional(),
  }),
  z.object({ kind: z.literal("tick-toggle"), on: z.boolean() }),
  // Encore plan demo: pre-creates a pending-clear ticket on disk
  // (so it survives reboot), embeds the ticket id in the seed
  // prompt, and seeds a chat that instructs the LLM to call
  // `confirm-and-clear` with that id when the user confirms.
  z.object({
    kind: z.literal("chat-start-and-store"),
    notificationId: z.string().min(1),
    role: z.string().optional(),
  }),
  // LLM-callable. Reads the pending-clear ticket file, calls
  // notifier.clear() for the recorded notificationId, and deletes
  // the ticket. Idempotent: a second call with the same id silently
  // succeeds (the file is gone, the notification is already cleared).
  z.object({ kind: z.literal("confirm-and-clear"), pendingId: z.string().min(1) }),
]);

// Pending-clear ticket file format. One file per ticket under
// `data/plugins/@mulmoclaude/debug-plugin/pending-clear/<pendingId>.json`.
// Plain JSON with one field today; structured-as-a-record so a
// future enhancement (e.g. expiry timestamp, originating obligation
// id) can extend the shape without a migration.
const PendingClearFile = z.object({ notificationId: z.string().min(1) });
const PENDING_CLEAR_DIR = "pending-clear";
function pendingClearPath(pendingId: string): string {
  return `${PENDING_CLEAR_DIR}/${pendingId}.json`;
}

// Seed prompt template — built server-side so the pendingId never
// flows through the URL or the browser. Phrased as first-person
// instructions to Claude (it's stored as a "user" turn in jsonl
// and Claude reads it as user instructions). The literal pendingId
// is visible to the human in the chat history; that's awkward but
// acceptable for the demo. Encore would refine the phrasing.
function buildAskAndStorePrompt(pendingId: string): string {
  return [
    "Ask me whether I received the notification you were just sent on my behalf.",
    'When I confirm yes, call the manageDebug tool with `kind` set to "confirm-and-clear" ',
    `and \`pendingId\` set to "${pendingId}". `,
    "After the tool returns, briefly tell me the notification was cleared.",
  ].join("");
}

interface MulmoclaudeNotifierApi {
  publish(input: {
    severity: z.infer<typeof NotifierSeverity>;
    lifecycle?: z.infer<typeof NotifierLifecycle> | undefined;
    title: string;
    body?: string | undefined;
    navigateTarget?: string | undefined;
    pluginData?: unknown;
  }): Promise<{ id: string }>;
  clear(id: string): Promise<void>;
}

interface MulmoclaudeTasksApi {
  register(task: { schedule: { type: "interval"; intervalMs: number } | { type: "daily"; time: string }; run: () => Promise<void> }): void;
}

interface MulmoclaudeChatApi {
  start(input: { initialMessage: string; role?: string | undefined }): Promise<{ chatId: string }>;
}

type MulmoclaudeRuntime = PluginRuntime & {
  notifier: MulmoclaudeNotifierApi;
  tasks: MulmoclaudeTasksApi;
  chat: MulmoclaudeChatApi;
};

// One-minute heartbeat. Off by default — toggle via the `tick-toggle`
// dispatch action so a fresh checkout doesn't fire a notification
// every minute. Useful for hand-testing the tasks runtime API end to
// end without booting Encore: when enabled, every tick posts a tiny
// fyi notification, so the dev sees the bell light up cleanly without
// needing to tail server logs.
const TICK_INTERVAL_MS = 60_000;

export default definePlugin((runtime) => {
  const { log, files } = runtime;
  const { notifier, tasks, chat } = runtime as MulmoclaudeRuntime;

  let tickEnabled = false;

  tasks.register({
    schedule: { type: "interval", intervalMs: TICK_INTERVAL_MS },
    run: async () => {
      if (!tickEnabled) return;
      log.info("tick", { enabled: tickEnabled });
      try {
        await notifier.publish({
          severity: "info",
          lifecycle: "fyi",
          title: "Debug tick",
          body: `Heartbeat at ${new Date().toISOString()}`,
        });
      } catch (err) {
        log.warn("tick: notifier.publish failed", { error: String(err) });
      }
    },
  });

  return {
    TOOL_DEFINITION,

    async manageDebug(rawArgs: unknown) {
      const args = Args.parse(rawArgs);

      switch (args.kind) {
        case "echo": {
          log.info("echo", { message: args.message });
          return { ok: true, kind: "echo", message: args.message };
        }

        case "publish": {
          const { id } = await notifier.publish({
            severity: args.severity,
            lifecycle: args.lifecycle,
            title: args.title,
            body: args.body,
            navigateTarget: args.navigateTarget,
          });
          log.info("publish", { id, lifecycle: args.lifecycle, severity: args.severity });
          return { ok: true, kind: "publish", id };
        }

        case "clear": {
          await notifier.clear(args.id);
          log.info("clear", { id: args.id });
          return { ok: true, kind: "clear" };
        }

        case "chat-start": {
          const { chatId } = await chat.start({
            initialMessage: args.initialMessage,
            role: args.role,
          });
          log.info("chat-start", { chatId, role: args.role ?? "general" });
          return { ok: true, kind: "chat-start", chatId };
        }

        case "tick-toggle": {
          tickEnabled = args.on;
          log.info("tick-toggle", { on: tickEnabled });
          return { ok: true, kind: "tick-toggle", on: tickEnabled };
        }

        case "chat-start-and-store": {
          // `globalThis.crypto.randomUUID()` (Web Crypto, available
          // in Node 19+ without import) — keeps this plugin off
          // `node:crypto` so the gui-chat-protocol eslint preset
          // stays happy.
          const pendingId = globalThis.crypto.randomUUID();
          await files.data.write(pendingClearPath(pendingId), JSON.stringify({ notificationId: args.notificationId }, null, 2));
          const initialMessage = buildAskAndStorePrompt(pendingId);
          const { chatId } = await chat.start({ initialMessage, role: args.role });
          log.info("chat-start-and-store", { chatId, pendingId, notificationId: args.notificationId });
          return { ok: true, kind: "chat-start-and-store", chatId, pendingId };
        }

        case "confirm-and-clear": {
          // Idempotent: missing file = ticket already used (or
          // never created) — silently succeed so a retried tool
          // call doesn't surface a misleading error to the LLM.
          const filePath = pendingClearPath(args.pendingId);
          if (!(await files.data.exists(filePath))) {
            log.info("confirm-and-clear: ticket not found", { pendingId: args.pendingId });
            return { ok: true, kind: "confirm-and-clear", cleared: false, reason: "ticket not found (already cleared or never created)" };
          }
          const raw = await files.data.read(filePath);
          let parsed;
          try {
            parsed = PendingClearFile.parse(JSON.parse(raw));
          } catch (err) {
            log.warn("confirm-and-clear: ticket malformed", { pendingId: args.pendingId, error: String(err) });
            await files.data.unlink(filePath);
            return { ok: false, kind: "confirm-and-clear", error: "pending-clear ticket malformed" };
          }
          await notifier.clear(parsed.notificationId);
          await files.data.unlink(filePath);
          log.info("confirm-and-clear", { pendingId: args.pendingId, notificationId: parsed.notificationId });
          return { ok: true, kind: "confirm-and-clear", cleared: true };
        }

        default: {
          const exhaustive: never = args;
          throw new Error(`unknown kind: ${JSON.stringify(exhaustive)}`);
        }
      }
    },
  };
});
