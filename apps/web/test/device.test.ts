import assert from "node:assert/strict";
import { test } from "node:test";
import { TeamkitError } from "@copilotkit/teamkit-client";
import { deviceErrorMessage, deviceMode, roomsToApprove } from "../lib/device";

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
