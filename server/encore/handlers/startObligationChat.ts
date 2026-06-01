// `startObligationChat` handler — user-initiated chat about a
// specific obligation. Reached from the dashboard chat button
// (`/encore` landing); NOT exposed in the LLM-facing tool schema.
//
// Compared to `resolveNotification` (the bell-click path):
//   - No ticket. There's no notification to clear and no severity
//     baseline to track — this is purely user-initiated.
//   - No reuse / idempotency. Each click yields a fresh chat. If
//     the user wants to continue a previous conversation, they
//     pick it from the sidebar instead.
//   - Seed prompt is localized from the DSL (id + displayName)
//     rather than read from a ticket.

import { z } from "zod";
import { randomUUID } from "node:crypto";

import { startChat } from "../../api/routes/agent.js";
import { PLUGIN_SESSION_ORIGIN_PREFIX } from "../../../src/types/session.js";
import { ENCORE_SEED_ROLE_ID } from "../../../src/config/roles.js";
import { ENCORE_PLUGIN_PKG } from "../notifier.js";
import { log } from "../../system/logger/index.js";
import { EncoreError, loadDsl, localizedSeedPrompt, type EncoreDispatchResult } from "./shared.js";

export const StartObligationChatArgs = z.object({
  kind: z.literal("startObligationChat"),
  obligationId: z.string().min(1),
  // The dashboard sends only the user's UI locale; the seed prompt text
  // is owned server-side and localized from `src/lang`
  // (`encoreDashboard.seedPrompts.obligation`). The obligation's
  // displayName is interpolated from the loaded DSL (server-trusted),
  // not from the client. An unsupported / omitted locale falls back to
  // English. (#1545)
  locale: z.string().optional(),
});

export async function handleStartObligationChat(args: z.infer<typeof StartObligationChatArgs>): Promise<EncoreDispatchResult> {
  const dsl = await loadDsl(args.obligationId);
  if (!dsl) {
    throw new EncoreError(404, `obligation ${JSON.stringify(args.obligationId)} not found`);
  }

  // Mention the obligationId in the prompt so the LLM can call
  // `manageEncore({ kind: "query", obligationId })` to read the current
  // state on its first turn without guessing.
  const chatSessionId = randomUUID();
  const result = await startChat({
    message: localizedSeedPrompt(args.locale, "obligation", {
      displayName: dsl.displayName,
      obligationId: args.obligationId,
    }),
    roleId: ENCORE_SEED_ROLE_ID,
    chatSessionId,
    origin: `${PLUGIN_SESSION_ORIGIN_PREFIX}${ENCORE_PLUGIN_PKG}`,
  });
  if (result.kind === "error") {
    throw new EncoreError(result.status ?? 500, `startObligationChat: startChat failed — ${result.error}`);
  }

  log.info("encore", "startObligationChat: chat seeded", {
    obligationId: args.obligationId,
    chatSessionId,
  });

  return {
    ok: true,
    message: `Encore: opened chat ${chatSessionId} for ${args.obligationId}.`,
    chatId: chatSessionId,
    navigateTo: `/chat/${chatSessionId}`,
  };
}
