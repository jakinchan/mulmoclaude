// Self-healing config: email + App Password, optional IMAP/SMTP
// host+port overrides. Same pattern as edgar-plugin — the LLM
// reads the `instructions` payload, asks the user, writes the
// JSON file via its built-in Write tool, then retries.
//
// We resolve IMAP/SMTP server settings in this order:
//   1. explicit `imap` / `smtp` block in the user's config.json
//   2. provider preset table keyed on the email's domain
//   3. otherwise → missing-config response that asks for the
//      block to be added
//
// Storing credentials in plain JSON inside the workspace matches
// existing plugin conventions (bookmarks / spotify / edgar). OS
// keyring integration is a v2+ concern.

import { homedir } from "node:os";
import { z } from "zod";
import type { PluginRuntime } from "gui-chat-protocol";

import { providerPresetForEmail, type HostPort, type ProviderPreset } from "./providers";

export const PKG_NAME = "@mulmoclaude/email-plugin";

const CONFIG_FILE = "config.json";

const HostPortSchema = z.object({
  host: z.string().min(1),
  port: z.number().int().min(1).max(65535),
  secure: z.boolean(),
});

const ConfigFileSchema = z.object({
  email: z.email(),
  // App Password (Gmail = 16-char alphanumeric, others vary). Not
  // tightly constrained — provider-specific shape varies and
  // mistypes surface via the IMAP/SMTP server's AUTH response.
  password: z.string().min(1),
  imap: HostPortSchema.optional(),
  smtp: HostPortSchema.optional(),
});

export type EmailConfigFile = z.infer<typeof ConfigFileSchema>;

/** Fully-resolved config used by the IMAP / SMTP clients. */
export interface ResolvedEmailConfig {
  email: string;
  password: string;
  imap: HostPort;
  smtp: HostPort;
}

/** Absolute path the plugin reads from / Claude must write to.
 *  Forward slashes throughout for Windows compatibility — see
 *  edgar-plugin/config.ts for the rationale. */
export function configAbsolutePath(): string {
  const seg = encodeURIComponent(PKG_NAME);
  const home = homedir().replace(/\\/g, "/");
  return `${home}/mulmoclaude/config/plugins/${seg}/${CONFIG_FILE}`;
}

/** Best-effort read of the raw config file. Returns null on any
 *  parse / shape mismatch so the dispatch returns self-healing
 *  instructions instead of throwing. */
export async function readConfigFile(files: PluginRuntime["files"]): Promise<EmailConfigFile | null> {
  try {
    if (!(await files.config.exists(CONFIG_FILE))) return null;
    const raw = await files.config.read(CONFIG_FILE);
    const parsed = ConfigFileSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export type ConfigResolution = { kind: "ok"; config: ResolvedEmailConfig } | { kind: "missing" } | { kind: "server_unknown"; email: string };

/** Promote the raw config to a fully-resolved one by filling in
 *  IMAP/SMTP defaults from the provider preset table. */
export function resolveConfig(raw: EmailConfigFile): ConfigResolution {
  const preset: ProviderPreset | null = providerPresetForEmail(raw.email);
  const imap = raw.imap ?? preset?.imap;
  const smtp = raw.smtp ?? preset?.smtp;
  if (!imap || !smtp) {
    return { kind: "server_unknown", email: raw.email };
  }
  return {
    kind: "ok",
    config: { email: raw.email, password: raw.password, imap, smtp },
  };
}

/** Combined read + resolve. */
export async function loadConfig(files: PluginRuntime["files"]): Promise<ConfigResolution> {
  const raw = await readConfigFile(files);
  if (!raw) return { kind: "missing" };
  return resolveConfig(raw);
}

/** Self-healing payload when config.json is absent or invalid. */
export function missingConfigResponse(): { instructions: string } {
  const path = configAbsolutePath();
  const schema = {
    email: "<user's email address>",
    password: "<App Password (NOT the main account password)>",
    "// imap (optional)": "Only needed if the provider isn't auto-detected; preset table covers gmail / fastmail / icloud / outlook.",
    imap: { host: "imap.example.com", port: 993, secure: true },
    smtp: { host: "smtp.example.com", port: 465, secure: true },
  };
  const prose =
    "This plugin needs the user's email address and an APP PASSWORD (not the main account password). " +
    "For Gmail: ask the user to enable 2FA and generate an App Password at https://myaccount.google.com/apppasswords. " +
    "Other providers have a similar setting under security/account. " +
    "Write the JSON file at the absolute path below, then retry the original tool call. " +
    "The `imap` and `smtp` blocks are optional — leave them out if the user is on gmail.com / fastmail.com / icloud.com / outlook.com (auto-detected). " +
    "**Never invent credentials.** Always ask the user.";
  return {
    instructions: `${prose}\n\nDetails (JSON):\n${JSON.stringify({ path, schema }, null, 2)}`,
  };
}

/** Self-healing payload when the user's domain isn't in the
 *  preset table and they haven't supplied explicit imap/smtp. */
export function serverUnknownResponse(email: string): { instructions: string } {
  const path = configAbsolutePath();
  const example = {
    email,
    password: "<existing App Password>",
    imap: { host: "imap.example.com", port: 993, secure: true },
    smtp: { host: "smtp.example.com", port: 465, secure: true },
  };
  const prose =
    `The domain in "${email}" isn't in the auto-detected preset list (gmail / fastmail / icloud / outlook). ` +
    "Ask the user for their IMAP and SMTP server settings (host + port + whether TLS is on-connect or STARTTLS), " +
    "then add an `imap` and `smtp` block to the existing config.json at the absolute path below, and retry.";
  return {
    instructions: `${prose}\n\nDetails (JSON):\n${JSON.stringify({ path, example }, null, 2)}`,
  };
}
