import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AGENT_APPS,
  AGENT_STYLE_NAME_ERROR,
  MAX_JOIN_NAME_LENGTH,
  agentAppLabel,
  emailDomain,
  isAgentApp,
  isAgentStyleName,
  normalizeDomain,
  normalizeEmail,
  normalizeJoinName,
  personAgentName,
} from "../src/join.js";

/** The actor name limit on the server (NAME_RE in apps/server/src/store/actors.ts). */
const MAX_ACTOR_NAME_LENGTH = 63;

test("personAgentName is <person>-<app>, or <person>-agent without an app", () => {
  assert.equal(personAgentName("ana"), "ana-agent");
  assert.equal(personAgentName("ana", "claude"), "ana-claude");
  assert.equal(personAgentName("ana", "codex"), "ana-codex");
});

test("the agent apps are claude and codex, with display labels", () => {
  assert.deepEqual([...AGENT_APPS], ["claude", "codex"]);
  assert.equal(isAgentApp("claude"), true);
  assert.equal(isAgentApp("codex"), true);
  for (const bad of ["", "Claude", "agent", "cursor", undefined, null, 1]) assert.equal(isAgentApp(bad), false, String(bad));
  assert.equal(agentAppLabel("claude"), "Claude");
  assert.equal(agentAppLabel("codex"), "Codex");
});

test("isAgentStyleName is true for names ending in -agent or an app suffix", () => {
  for (const name of ["ben-agent", "ben-claude", "ben-codex", "a-b-codex"]) assert.equal(isAgentStyleName(name), true, name);
  for (const name of ["ben", "agent", "claude", "codex", "ben-agents", "ben-claudes", "bencodex"]) {
    assert.equal(isAgentStyleName(name), false, name);
  }
  assert.equal(AGENT_STYLE_NAME_ERROR, "a person's name cannot end in -agent, -claude or -codex; that is how agent names end");
});

test("a joining name leaves room for the longest agent suffix within the actor name limit", () => {
  assert.equal(MAX_JOIN_NAME_LENGTH, 56);
  const longest = Math.max(...["agent", ...AGENT_APPS].map((s) => s.length + 1));
  assert.equal(MAX_JOIN_NAME_LENGTH + longest, MAX_ACTOR_NAME_LENGTH);
  for (const app of AGENT_APPS) {
    assert.ok(personAgentName("a".repeat(MAX_JOIN_NAME_LENGTH), app).length <= MAX_ACTOR_NAME_LENGTH, app);
  }
});

test("normalizeJoinName trims and lower-cases, and refuses what an agent name cannot carry", () => {
  assert.equal(normalizeJoinName("  Ana "), "ana");
  assert.equal(normalizeJoinName("ben-2"), "ben-2");
  assert.equal(normalizeJoinName("a".repeat(56)), "a".repeat(56));
  // A person named like an agent would take that agent's name from its owner.
  for (const bad of ["", "Ana Lopez", "-ana", "ana_b", "ána", "a".repeat(57), "ben-agent", " Ben-Agent ", "ben-claude", "ben-codex", " Ben-Codex "]) {
    assert.equal(normalizeJoinName(bad), null, bad);
  }
});

test("normalizeEmail lower-cases and checks the shape", () => {
  assert.equal(normalizeEmail(" Ana@Example.COM "), "ana@example.com");
  for (const bad of ["", "ana", "ana@", "@example.com", "ana@example", "ana@@example.com", "a b@example.com", `${"a".repeat(250)}@example.com`]) {
    assert.equal(normalizeEmail(bad), null, bad);
  }
});

test("normalizeDomain strips one leading @ and lower-cases", () => {
  assert.equal(normalizeDomain("@Example.com"), "example.com");
  assert.equal(normalizeDomain("eu.example.com"), "eu.example.com");
  for (const bad of ["", "example", "-example.com", "exa mple.com", "example..com"]) {
    assert.equal(normalizeDomain(bad), null, bad);
  }
});

test("emailDomain is the part after the @", () => {
  assert.equal(emailDomain("ana@example.com"), "example.com");
});
