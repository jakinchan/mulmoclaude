// Provider preset table — derive IMAP / SMTP host+port from the
// user's email domain so they don't have to look up the server
// settings for common providers. The user can override either
// section in their config.json if their setup differs.

export interface HostPort {
  host: string;
  port: number;
  /** TLS-on-connect (993 IMAP / 465 SMTP) when true; STARTTLS upgrade (143 / 587) when false. */
  secure: boolean;
}

export interface ProviderPreset {
  imap: HostPort;
  smtp: HostPort;
}

// Lowercased domain → preset. Keep entries to providers the
// MulmoClaude users actually use; we'd rather return a
// `config_required` for unknown domains than guess wrong and
// silently send mail through the wrong server.
const PRESETS: Record<string, ProviderPreset> = {
  "gmail.com": {
    imap: { host: "imap.gmail.com", port: 993, secure: true },
    smtp: { host: "smtp.gmail.com", port: 465, secure: true },
  },
  "googlemail.com": {
    imap: { host: "imap.gmail.com", port: 993, secure: true },
    smtp: { host: "smtp.gmail.com", port: 465, secure: true },
  },
  "fastmail.com": {
    imap: { host: "imap.fastmail.com", port: 993, secure: true },
    smtp: { host: "smtp.fastmail.com", port: 465, secure: true },
  },
  "icloud.com": {
    imap: { host: "imap.mail.me.com", port: 993, secure: true },
    smtp: { host: "smtp.mail.me.com", port: 587, secure: false },
  },
  "me.com": {
    imap: { host: "imap.mail.me.com", port: 993, secure: true },
    smtp: { host: "smtp.mail.me.com", port: 587, secure: false },
  },
  "outlook.com": {
    imap: { host: "outlook.office365.com", port: 993, secure: true },
    smtp: { host: "smtp.office365.com", port: 587, secure: false },
  },
  "hotmail.com": {
    imap: { host: "outlook.office365.com", port: 993, secure: true },
    smtp: { host: "smtp.office365.com", port: 587, secure: false },
  },
};

/** Lookup preset by the user's email domain. Returns null when
 *  the domain isn't in the table — the caller should fall back to
 *  reading the user-supplied `imap` / `smtp` blocks from config,
 *  and emit `config_required` if those are also missing. */
export function providerPresetForEmail(email: string): ProviderPreset | null {
  const at = email.lastIndexOf("@");
  if (at < 0) return null;
  const domain = email.slice(at + 1).toLowerCase();
  return PRESETS[domain] ?? null;
}
