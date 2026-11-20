import assert from "node:assert/strict";
import { test } from "node:test";
import { TeamkitError } from "@copilotkit/teamkit-client";
import { agentDeviceText, deviceApp, deviceErrorMessage, deviceMode, roomsToApprove } from "../lib/device";

test("deviceMode is agent only for mode=agent", () => {
  assert.equal(deviceMode(new URLSearchParams("code=BCDF-GHJK&mode=agent")), "agent");
  assert.equal(deviceMode(new URLSearchParams("code=BCDF-GHJK")), "admin");
  assert.equal(deviceMode(new URLSearchParams("mode=AGENT")), "admin");
});

test("roomsToApprove merges picked and typed rooms, lower-cased and de-duplicated", () => {
  assert.deepEqual(roomsToApprove(["billing-migration"], " Billing-Prod, billing-migration "),
    { rooms: ["billing-migration", "billing-prod"], invalid: [] });
  assert.deepEqual(roomsToApprove([], "billing-prod prod!"), { rooms: ["billing-prod"], invalid: ["prod!"] });
  assert.deepEqual(roomsToApprove([], ""), { rooms: [], invalid: [] });
});

test("device errors name the command to run again", () => {
  assert.equal(deviceErrorMessage(new TeamkitError("not_found", 404, "unknown or expired code"), "agent"),
    "That code is unknown or expired. Run `teamkit join` again.");
  assert.equal(deviceErrorMessage(new TeamkitError("not_found", 404, "unknown or expired code"), "admin"),
    "That code is unknown or expired. Run `teamkit login` again.");
  assert.equal(deviceErrorMessage(new TeamkitError("name_taken", 409, "the name ana-agent belongs to someone else; ask an admin"), "agent"),
    "The name ana-agent belongs to someone else; ask an admin.");
});

test("deviceApp reads a known app from the URL and ignores anything else", () => {
  assert.equal(deviceApp(new URLSearchParams("code=BCDF-GHJK&mode=agent&app=codex")), "codex");
  assert.equal(deviceApp(new URLSearchParams("code=BCDF-GHJK&mode=agent&app=claude")), "claude");
  for (const q of ["code=BCDF-GHJK&mode=agent", "mode=agent&app=cursor", "mode=agent&app=Codex", "mode=agent&app="]) {
    assert.equal(deviceApp(new URLSearchParams(q)), null, q);
  }
});

test("the agent device page names the app and the agent it connects, or says what it says today", () => {
  const ROOMS = "It can read, post, claim and create tasks in the rooms you pick.";
  assert.deepEqual(agentDeviceText("ana", "codex"), {
    title: "Connect your Codex",
    lead: `Your agent will be ana-codex, an agent that belongs to you. ${ROOMS}`,
    agent: "ana-codex",
  });
  assert.equal(agentDeviceText("ana", "claude").title, "Connect your Claude");
  assert.equal(agentDeviceText("ana", "claude").agent, "ana-claude");
  assert.deepEqual(agentDeviceText("ana", null), {
    title: "Connect your agent",
    lead: `This signs in ana-agent, an agent that belongs to you. ${ROOMS}`,
    agent: "ana-agent",
  });
  assert.equal(agentDeviceText(null, null).agent, "your agent");
  assert.equal(agentDeviceText(null, "codex").agent, "your Codex agent");
});
