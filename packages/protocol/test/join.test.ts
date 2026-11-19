import { test } from "node:test";
import assert from "node:assert/strict";
import { emailDomain, normalizeDomain, normalizeEmail, normalizeJoinName, personAgentName } from "../src/join.js";

test("personAgentName appends -agent", () => {
  assert.equal(personAgentName("ana"), "ana-agent");
});

test("normalizeJoinName trims and lower-cases, and refuses what an agent name cannot carry", () => {
  assert.equal(normalizeJoinName("  Ana "), "ana");
  assert.equal(normalizeJoinName("ben-2"), "ben-2");
  assert.equal(normalizeJoinName("a".repeat(57)), "a".repeat(57));
  for (const bad of ["", "Ana Lopez", "-ana", "ana_b", "ána", "a".repeat(58)]) {
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
