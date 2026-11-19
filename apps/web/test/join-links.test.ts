import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { JoinLink } from "@copilotkit/teamkit-protocol";
import { inviteEmail, joinLinkStatus, parseDays, parseDomains } from "../lib/join-links.js";

describe("join links", () => {
  it("parseDomains normalizes, dedupes and rejects non-domains", () => {
    assert.deepEqual(parseDomains(""), []);
    assert.deepEqual(parseDomains(" @Example.com, example.com  billing.example.com "), ["example.com", "billing.example.com"]);
    assert.throws(() => parseDomains("example"), /"example" is not an email domain/);
  });
  it("parseDays takes a whole number of days or nothing", () => {
    assert.equal(parseDays(""), undefined);
    assert.equal(parseDays(" 30 "), 30);
    for (const bad of ["0", "1.5", "-2", "soon"]) assert.throws(() => parseDays(bad), /whole number of days/);
  });
  it("joinLinkStatus", () => {
    const now = Date.parse("2026-11-19T10:00:00.000Z");
    const l: JoinLink = { id: "jl_1", createdAt: "2026-11-01T00:00:00.000Z", expiresAt: null, domains: ["example.com"], revokedAt: null, uses: 3 };
    assert.equal(joinLinkStatus(l, now), "active");
    assert.equal(joinLinkStatus({ ...l, expiresAt: "2026-11-19T10:00:00.000Z" }, now), "expired");
    assert.equal(joinLinkStatus({ ...l, expiresAt: "2026-11-19T10:00:00.000Z", revokedAt: "2026-11-02T00:00:00.000Z" }, now), "revoked");
  });
  it("inviteEmail is optional, lower-cased, and checked", () => {
    assert.equal(inviteEmail("  "), undefined);
    assert.equal(inviteEmail(" Ben@Example.com "), "ben@example.com");
    assert.throws(() => inviteEmail("ben"), /That is not an email address/);
  });
});
