import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.js";

test("host defaults to loopback and HOST overrides it", () => {
  assert.equal(loadConfig({}).host, "127.0.0.1");
  assert.equal(loadConfig({ HOST: "0.0.0.0" }).host, "0.0.0.0");
});

test("TEAMKIT_PUBLIC_URL rejects an empty or invalid port", () => {
  for (const bad of ["http://localhost:", "http://localhost:/", "https://b.example.com:?x=1", "http://localhost:99999", "http://localhost:abc"]) {
    assert.throws(() => loadConfig({ TEAMKIT_PUBLIC_URL: bad }), /TEAMKIT_PUBLIC_URL/, bad);
  }
  assert.equal(loadConfig({ TEAMKIT_PUBLIC_URL: "http://localhost:3000/" }).publicUrl, "http://localhost:3000");
  assert.equal(loadConfig({ TEAMKIT_PUBLIC_URL: "http://[::1]:3000" }).publicUrl, "http://[::1]:3000");
});

test("mail is off unless TEAMKIT_SMTP_URL is set, and then needs TEAMKIT_MAIL_FROM", () => {
  assert.equal(loadConfig({}).mail, null);
  const from = "AG-UI TeamKit <teamkit@example.com>";
  assert.deepEqual(loadConfig({ TEAMKIT_SMTP_URL: "smtp://mail.example.com:587", TEAMKIT_MAIL_FROM: from }).mail,
    { smtpUrl: "smtp://mail.example.com:587", from });
  assert.throws(() => loadConfig({ TEAMKIT_SMTP_URL: "smtp://mail.example.com" }), /TEAMKIT_MAIL_FROM is required/);
  assert.throws(() => loadConfig({ TEAMKIT_SMTP_URL: "https://user:hunter2@mail.example.com", TEAMKIT_MAIL_FROM: from }),
    (e: Error) => /smtp:\/\/ or smtps:\/\//.test(e.message) && !e.message.includes("hunter2"));
});
