// Zod input schema for the `manageEmail` tool. Discriminated union
// keyed on `kind` so the dispatch in `index.ts` gets a narrowed
// type per branch. Lives in its own module so unit tests can
// import without spinning up the runtime.

import { z } from "zod";

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const ListArgs = z.object({
  kind: z.literal("list"),
  mailbox: z.string().min(1).default("INBOX"),
  limit: z.number().int().min(1).max(200).default(20),
});

const ReadArgs = z.object({
  kind: z.literal("read"),
  mailbox: z.string().min(1).default("INBOX"),
  uid: z.number().int().min(1),
});

const SearchArgs = z.object({
  kind: z.literal("search"),
  mailbox: z.string().min(1).default("INBOX"),
  limit: z.number().int().min(1).max(200).default(20),
  from: z.string().min(1).optional(),
  subject_contains: z.string().min(1).optional(),
  since: z.string().regex(ISO_DATE_RE).optional(),
  before: z.string().regex(ISO_DATE_RE).optional(),
  unread: z.boolean().optional(),
});

// `to` accepts a single RFC-5321-shaped address. v1 keeps it
// single-recipient; multi-to / cc / bcc land in v2.
const EMAIL_LOCAL = "[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*";
const EMAIL_DOMAIN = "[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+";
const EMAIL_RE = new RegExp(`^${EMAIL_LOCAL}@${EMAIL_DOMAIN}$`);

const SendArgs = z.object({
  kind: z.literal("send"),
  to: z.string().regex(EMAIL_RE, "must be a valid email address"),
  subject: z.string().min(1),
  body: z.string(),
  html: z.string().optional(),
  // confirmed === true means the user has approved the
  // confirmation form. The dispatch refuses to actually send
  // without it (see send-gate doc in definition.ts).
  confirmed: z.boolean().optional(),
});

export const Args = z.discriminatedUnion("kind", [ListArgs, ReadArgs, SearchArgs, SendArgs]);
export type EmailArgs = z.infer<typeof Args>;
