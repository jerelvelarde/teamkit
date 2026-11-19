/** One plain-text email. */
export interface MailMessage {
  to: string;
  subject: string;
  text: string;
}

/** Sends email. The server has one only when TEAMKIT_SMTP_URL is set. */
export interface Mailer {
  send(msg: MailMessage): Promise<void>;
}

export function signInEmail(input: { to: string; person: string; link: string }): MailMessage {
  return {
    to: input.to,
    subject: "Your AG-UI TeamKit sign-in link",
    text:
      `Hi ${input.person},\n\nOpen this link to sign in to AG-UI TeamKit:\n${input.link}\n\n` +
      "It works once, within 30 minutes. If you did not ask for it, ignore this email.\n",
  };
}
