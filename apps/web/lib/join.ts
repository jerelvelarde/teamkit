import { TeamkitError } from "@copilotkit/teamkit-client";

export interface JoinErrorView {
  message: string;
  /** The person may already be on the team: point them at email sign-in. */
  offerEmailSignIn: boolean;
}

/** "the name ana is taken" reads "The name ana is taken." */
export function sentence(s: string): string {
  const t = s.trim().replace(/[.\s]+$/, "");
  return t === "" ? t : `${t[0]!.toUpperCase()}${t.slice(1)}.`;
}

export function joinErrorMessage(err: unknown): JoinErrorView {
  if (err instanceof TeamkitError) {
    switch (err.code) {
      case "join_link_invalid":
        return { message: "This join link is invalid, revoked or expired. Ask a teammate for the current one.", offerEmailSignIn: false };
      case "name_taken":
      case "email_taken":
        return { message: `${sentence(err.message)} If it's yours, get a sign-in link by email.`, offerEmailSignIn: true };
      case "email_domain_not_allowed":
      case "invalid_input":
        return { message: sentence(err.message), offerEmailSignIn: false };
      case "rate_limited":
        return { message: "Too many tries. Wait a minute and try again.", offerEmailSignIn: false };
    }
  }
  return { message: "Joining failed. Try again.", offerEmailSignIn: false };
}

export function emailSignInErrorMessage(err: unknown): string {
  if (err instanceof TeamkitError) {
    switch (err.code) {
      case "invalid_state":
        return "This server can't send email. Ask an admin for a sign-in link.";
      case "rate_limited":
        return "Too many requests. Wait a minute and try again.";
      case "invalid_input":
        return "That is not an email address.";
    }
  }
  return "Something went wrong. Try again.";
}
