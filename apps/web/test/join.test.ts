import assert from "node:assert/strict";
import { test } from "node:test";
import { TeamkitError } from "@copilotkit/teamkit-client";
import { emailSignInErrorMessage, joinErrorMessage } from "../lib/join";

const e = (code: string, status: number, message = "") => new TeamkitError(code, status, message);

test("join errors read as next steps, and taken names or emails offer email sign-in", () => {
  assert.deepEqual(joinErrorMessage(e("join_link_invalid", 404)),
    { message: "This join link is invalid, revoked or expired. Ask a teammate for the current one.", offerEmailSignIn: false });
  assert.deepEqual(joinErrorMessage(e("email_domain_not_allowed", 403, "this join link only accepts emails at example.com")),
    { message: "This join link only accepts emails at example.com.", offerEmailSignIn: false });
  assert.deepEqual(joinErrorMessage(e("name_taken", 409, "the name ana is taken")),
    { message: "The name ana is taken. If it's yours, get a sign-in link by email.", offerEmailSignIn: true });
  assert.deepEqual(joinErrorMessage(e("email_taken", 409, "that email already belongs to someone on this team")),
    { message: "That email already belongs to someone on this team. If it's yours, get a sign-in link by email.", offerEmailSignIn: true });
  assert.deepEqual(joinErrorMessage(e("invalid_input", 400, "names are lowercase letters, digits and hyphens, up to 57 characters")),
    { message: "Names are lowercase letters, digits and hyphens, up to 57 characters.", offerEmailSignIn: false });
  assert.deepEqual(joinErrorMessage(e("rate_limited", 429)), { message: "Too many tries. Wait a minute and try again.", offerEmailSignIn: false });
  assert.deepEqual(joinErrorMessage(new TypeError("fetch failed")), { message: "Joining failed. Try again.", offerEmailSignIn: false });
});

test("email sign-in errors say what to do", () => {
  assert.equal(emailSignInErrorMessage(e("invalid_state", 409)), "This server can't send email. Ask an admin for a sign-in link.");
  assert.equal(emailSignInErrorMessage(e("rate_limited", 429)), "Too many requests. Wait a minute and try again.");
  assert.equal(emailSignInErrorMessage(e("invalid_input", 400)), "That is not an email address.");
  assert.equal(emailSignInErrorMessage(new TypeError("fetch failed")), "Something went wrong. Try again.");
});
