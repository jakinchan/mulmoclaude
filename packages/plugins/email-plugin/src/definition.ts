// Tool schema for `manageEmail`. One tool, kind-discriminated.
// The LLM picks `list` / `read` / `search` / `send`; dispatch in
// `index.ts` validates args with Zod and routes.
//
// v1 surface only — label / archive / trash / draft / attachment
// upload are deferred. See #1542 for the full roadmap.

export const TOOL_DEFINITION = {
  type: "function" as const,
  name: "manageEmail" as const,
  prompt:
    "Configuration: this plugin needs the user's email address and an **App Password** (NOT their main account password). " +
    "For Gmail, the user must enable 2FA, then generate an App Password at https://myaccount.google.com/apppasswords. " +
    "For other providers (Fastmail, iCloud, Outlook) the App Password setting is in their security/account page. " +
    "The plugin reads `~/mulmoclaude/config/plugins/%40mulmoclaude%2Femail-plugin/config.json` with shape " +
    '`{"email":"<address>","password":"<app-password>","imap":{"host":..,"port":..,"secure":..}?,"smtp":{"host":..,"port":..,"secure":..}?}`. ' +
    "If the file is missing the tool returns an `instructions` payload; ask the user, write the JSON file, then retry. " +
    "**Never invent credentials**, never store the user's main account password. " +
    "**Send is gated**: calling `kind:'send'` first returns a payload that asks the host to render a confirmation form — the actual SMTP send only happens after the user explicitly approves on a second `kind:'send'` call with `confirmed:true`.",
  description:
    "Read / search / send email via IMAP + SMTP. Generic — works with Gmail (default), Fastmail, iCloud, Outlook, or any IMAP/SMTP server. Supported kinds:\n" +
    " - `list`: list recent messages from the inbox (subject, from, date, unread flag). Use `limit` to cap; default 20.\n" +
    " - `read`: fetch the full body + headers + attachment metadata for one message by its IMAP UID.\n" +
    " - `search`: IMAP SEARCH — filter by `from`, `subject_contains`, `since`, `before`, `unread`. Combine criteria.\n" +
    " - `send`: SMTP send. ALWAYS requires a two-step confirm: first call returns a form for the user; second call (with the user-confirmed args + `confirmed:true`) actually sends.",
  parameters: {
    type: "object" as const,
    properties: {
      kind: {
        type: "string",
        enum: ["list", "read", "search", "send"],
        description: "Which email operation to perform.",
      },
      // list
      mailbox: { type: "string", description: "For `list`/`search`: IMAP mailbox (default 'INBOX')." },
      limit: { type: "integer", minimum: 1, maximum: 200, description: "For `list`/`search`: max messages (default 20)." },
      // read
      uid: { type: "integer", minimum: 1, description: "For `read`: IMAP UID of the message (from a prior `list` or `search` result)." },
      // search
      from: { type: "string", description: "For `search`: filter by sender address or display name (substring match)." },
      subject_contains: { type: "string", description: "For `search`: filter by subject substring." },
      since: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$", description: "For `search`: only messages on or after this ISO date." },
      before: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$", description: "For `search`: only messages strictly before this ISO date." },
      unread: { type: "boolean", description: "For `search`: only unread messages when true." },
      // send
      to: { type: "string", description: "For `send`: recipient address (single, v1)." },
      subject: { type: "string", description: "For `send`: subject line." },
      body: { type: "string", description: "For `send`: plain-text body." },
      html: { type: "string", description: "For `send`: optional HTML body (used in addition to `body` as multipart/alternative)." },
      confirmed: {
        type: "boolean",
        description:
          "For `send`: MUST be `true` on the second call (after the user approves the confirmation form). Omit/false on first call to surface the form.",
      },
    },
    required: ["kind"],
  },
};
