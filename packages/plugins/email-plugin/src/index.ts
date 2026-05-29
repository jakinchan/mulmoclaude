// Email plugin — server-side runtime plugin (#1542).
//
// One tool (`manageEmail`), four kinds (`list` / `read` / `search`
// / `send`). v1 ships real IMAP via `imapflow` + `mailparser` and
// SMTP via `nodemailer`. Auth is App Password (no OAuth in v1).
//
// Send-gate contract: the first `kind:'send'` call (with no
// `confirmed:true`) returns a structured payload telling the LLM
// to show the draft to the user via presentForm and only re-call
// with `confirmed:true` after the user explicitly approves. The
// dispatch refuses to actually call SMTP without `confirmed:true`.

import { definePlugin } from "gui-chat-protocol";

import { TOOL_DEFINITION } from "./definition";
import { Args, type EmailArgs } from "./args";
import { loadConfig, missingConfigResponse, serverUnknownResponse, type ResolvedEmailConfig } from "./config";
import { listMessages, readMessage, searchMessages } from "./imap";
import { sendMail } from "./smtp";

export { TOOL_DEFINITION };

interface SendConfirmRequest {
  needs_confirmation: true;
  message: string;
  draft: { to: string; subject: string; body: string; html?: string };
  retry_with: { kind: "send"; to: string; subject: string; body: string; html?: string; confirmed: true };
}

function buildSendConfirmation(args: Extract<EmailArgs, { kind: "send" }>): SendConfirmRequest {
  return {
    needs_confirmation: true,
    message:
      "About to send email. Call `presentForm` to show the user the draft (to / subject / body) and ask them to confirm. " +
      "Only re-call `manageEmail` with `confirmed:true` after the user explicitly approves.",
    draft: { to: args.to, subject: args.subject, body: args.body, ...(args.html ? { html: args.html } : {}) },
    retry_with: { kind: "send", to: args.to, subject: args.subject, body: args.body, ...(args.html ? { html: args.html } : {}), confirmed: true },
  };
}

async function handleList(cfg: ResolvedEmailConfig, args: Extract<EmailArgs, { kind: "list" }>): Promise<unknown> {
  return await listMessages({ email: cfg.email, password: cfg.password, imap: cfg.imap }, args.mailbox, args.limit);
}

async function handleRead(cfg: ResolvedEmailConfig, args: Extract<EmailArgs, { kind: "read" }>): Promise<unknown> {
  return await readMessage({ email: cfg.email, password: cfg.password, imap: cfg.imap }, args.mailbox, args.uid);
}

async function handleSearch(cfg: ResolvedEmailConfig, args: Extract<EmailArgs, { kind: "search" }>): Promise<unknown> {
  return await searchMessages(
    { email: cfg.email, password: cfg.password, imap: cfg.imap },
    args.mailbox,
    { from: args.from, subject_contains: args.subject_contains, since: args.since, before: args.before, unread: args.unread },
    args.limit,
  );
}

async function handleSend(cfg: ResolvedEmailConfig, args: Extract<EmailArgs, { kind: "send" }>): Promise<unknown> {
  if (args.confirmed !== true) return buildSendConfirmation(args);
  return await sendMail({ email: cfg.email, password: cfg.password, smtp: cfg.smtp }, args);
}

async function dispatch(cfg: ResolvedEmailConfig, args: EmailArgs): Promise<unknown> {
  switch (args.kind) {
    case "list":
      return handleList(cfg, args);
    case "read":
      return handleRead(cfg, args);
    case "search":
      return handleSearch(cfg, args);
    case "send":
      return handleSend(cfg, args);
    default: {
      const exhaustive: never = args;
      throw new Error(`unknown manageEmail kind: ${JSON.stringify(exhaustive)}`);
    }
  }
}

export default definePlugin(({ files }) => {
  return {
    TOOL_DEFINITION,

    async manageEmail(rawArgs: unknown) {
      const resolution = await loadConfig(files);
      if (resolution.kind === "missing") return missingConfigResponse();
      if (resolution.kind === "server_unknown") return serverUnknownResponse(resolution.email);

      const parsed = Args.safeParse(rawArgs);
      if (!parsed.success) {
        return { instructions: `Invalid manageEmail arguments: ${parsed.error.issues.map((issue) => issue.message).join("; ")}` };
      }

      try {
        const result = await dispatch(resolution.config, parsed.data);
        return { message: JSON.stringify(result) };
      } catch (err) {
        return { instructions: `manageEmail call failed: ${err instanceof Error ? err.message : String(err)}` };
      }
    },
  };
});
