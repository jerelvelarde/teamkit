import assert from "node:assert/strict";
import { test } from "node:test";
import { TeamkitError } from "@copilotkit/teamkit-client";
import { whoamiFailureState } from "../lib/session";

test("only a 401 from whoami reads as signed out", () => {
  assert.equal(whoamiFailureState(new TeamkitError("unauthorized", 401, "session expired")), "signed_out");
  assert.equal(whoamiFailureState(new TeamkitError("bad_gateway", 502, "teamkit-server is unreachable")), "unavailable");
  assert.equal(whoamiFailureState(new TeamkitError("http_error", 500, "")), "unavailable");
  assert.equal(whoamiFailureState(new TeamkitError("not_found", 404, "no such route")), "unavailable");
  assert.equal(whoamiFailureState(new TypeError("fetch failed")), "unavailable");
});
