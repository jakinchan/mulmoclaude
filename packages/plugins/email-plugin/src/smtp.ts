// SMTP send wrapper. nodemailer handles the transport (AUTH PLAIN
// for App Password, STARTTLS or TLS-on-connect depending on the
// resolved port). One transporter per call for v1 to match the
// IMAP side; pooling is a v2 optimisation.

import nodemailer from "nodemailer";

import type { HostPort } from "./providers";

export interface SmtpAuth {
  email: string;
  password: string;
  smtp: HostPort;
}

export interface SendDraft {
  to: string;
  subject: string;
  body: string;
  html?: string;
}

export interface SendResult {
  messageId: string;
  accepted: string[];
  rejected: string[];
}

export async function sendMail(auth: SmtpAuth, draft: SendDraft): Promise<SendResult> {
  const transporter = nodemailer.createTransport({
    host: auth.smtp.host,
    port: auth.smtp.port,
    secure: auth.smtp.secure,
    auth: { user: auth.email, pass: auth.password },
  });
  try {
    const info = await transporter.sendMail({
      from: auth.email,
      to: draft.to,
      subject: draft.subject,
      text: draft.body,
      ...(draft.html ? { html: draft.html } : {}),
    });
    return {
      messageId: info.messageId,
      accepted: (info.accepted ?? []).map((a) => (typeof a === "string" ? a : (a.address ?? ""))).filter((s) => s.length > 0),
      rejected: (info.rejected ?? []).map((a) => (typeof a === "string" ? a : (a.address ?? ""))).filter((s) => s.length > 0),
    };
  } finally {
    transporter.close();
  }
}
