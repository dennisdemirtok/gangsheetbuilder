import nodemailer from "nodemailer";

/**
 * Outgoing mail through the shop's own Google Workspace mailbox.
 *
 * Sending as dennis@transfercraft.com through Google keeps every message in
 * his Sent folder, replies from the print shop land in his inbox, and it
 * passes the domain's SPF/DKIM/DMARC (p=quarantine) without new DNS records.
 * Google needs an app password for SMTP: SMTP_PASS is that, set in Railway.
 */

export interface MailAttachment {
  filename: string;
  content: Buffer;
  contentType?: string;
}

export interface OutgoingMail {
  to: string;
  subject: string;
  html: string;
  text: string;
  replyTo?: string;
  attachments?: MailAttachment[];
  /** Overrides MAIL_FROM, e.g. for mail to customers. */
  from?: string;
}

const SMTP_USER = () => process.env.SMTP_USER || "";

export function mailFrom(): string {
  return process.env.MAIL_FROM || `Transfercraft <${SMTP_USER()}>`;
}

/** Missing settings, so the admin can say why mail cannot be sent. */
export function missingMailConfig(): string[] {
  const missing: string[] = [];
  if (!process.env.SMTP_USER) missing.push("SMTP_USER");
  if (!process.env.SMTP_PASS) missing.push("SMTP_PASS");
  return missing;
}

let transport: nodemailer.Transporter | null = null;

function getTransport() {
  if (!transport) {
    const port = Number(process.env.SMTP_PORT || 465);
    transport = nodemailer.createTransport({
      host: process.env.SMTP_HOST || "smtp.gmail.com",
      port,
      secure: port === 465,
      // Google shows app passwords in groups of four ("abcd efgh …").
      auth: { user: SMTP_USER(), pass: (process.env.SMTP_PASS || "").replace(/\s+/g, "") },
    });
  }
  return transport;
}

export async function sendMail(mail: OutgoingMail): Promise<{ messageId: string }> {
  const missing = missingMailConfig();
  if (missing.length > 0) {
    throw new Error(`Email is not set up: missing ${missing.join(", ")}`);
  }
  const info = await getTransport().sendMail({
    from: mail.from || mailFrom(),
    to: mail.to,
    replyTo: mail.replyTo,
    subject: mail.subject,
    html: mail.html,
    text: mail.text,
    attachments: mail.attachments,
  });
  return { messageId: info.messageId };
}

/** Logs in to the mail server without sending anything — for the settings page. */
export async function verifyMail(): Promise<{ ok: boolean; error?: string }> {
  const missing = missingMailConfig();
  if (missing.length > 0) return { ok: false, error: `Missing ${missing.join(", ")}` };
  try {
    await Promise.race([
      getTransport().verify(),
      new Promise((_, reject) => setTimeout(() => reject(new Error("timed out")), 8000)),
    ]);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: (error as Error).message.slice(0, 200) };
  }
}
