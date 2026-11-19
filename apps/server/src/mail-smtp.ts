import { createTransport } from "nodemailer";
import type { Mailer } from "./mail.js";

/** A mailer that sends over SMTP. The URL may carry credentials; it lives only in the environment. */
export function smtpMailer(opts: { url: string; from: string }): Mailer {
  const transport = createTransport(opts.url);
  return {
    async send(msg) {
      await transport.sendMail({ from: opts.from, to: msg.to, subject: msg.subject, text: msg.text });
    },
  };
}
