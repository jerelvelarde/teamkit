import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ALERT_LEVELS,
  CHANGE_STATUSES,
  EVENT_KINDS,
  HEARTBEAT_EVERY_MS,
  ID_PREFIXES,
  MAX_APPROVERS,
  PRESENCE_ON_MS,
  RESERVATION_MINUTES_DEFAULT,
  RESERVATION_MINUTES_MAX,
  ROLLCALL_OPEN_MS,
  newId,
} from "../src/index.js";

test("EVENT_KINDS ends with the ten coordination kinds, in order", () => {
  assert.deepEqual(EVENT_KINDS.slice(-10), ["task.handed_off", "decision.posted", "decision.acked", "rollcall.started",
    "rollcall.answered", "change.logged", "change.updated", "alert.raised", "alert.confirmed", "alert.resolved"]);
});

test("coordination constants and id prefixes", () => {
  assert.equal(RESERVATION_MINUTES_DEFAULT, 30);
  assert.equal(RESERVATION_MINUTES_MAX, 1440);
  assert.equal(HEARTBEAT_EVERY_MS, 30_000);
  assert.equal(PRESENCE_ON_MS, 90_000);
  assert.equal(ROLLCALL_OPEN_MS, 3_600_000);
  assert.equal(MAX_APPROVERS, 10);
  assert.deepEqual(CHANGE_STATUSES, ["active", "done", "restored"]);
  assert.deepEqual(ALERT_LEVELS, ["suspected", "confirmed"]);
  assert.match(newId(ID_PREFIXES.decision), /^dec_[0-9a-f]{16}$/);
  assert.match(newId(ID_PREFIXES.rollCall), /^rc_[0-9a-f]{16}$/);
  assert.match(newId(ID_PREFIXES.change), /^chg_[0-9a-f]{16}$/);
  assert.match(newId(ID_PREFIXES.alert), /^alr_[0-9a-f]{16}$/);
});
