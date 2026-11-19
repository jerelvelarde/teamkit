import type { DeviceMode, DeviceStart } from "@copilotkit/teamkit-protocol";
import { startDeviceLogin, TeamkitError } from "@copilotkit/teamkit-client";
import { CliExit } from "./errors.js";

/** Asks the server for a login code; a rate-limited request exits 1 with how long to wait. */
export async function startDeviceOrExit(url: string, mode: DeviceMode): Promise<DeviceStart> {
  try {
    return await startDeviceLogin(url, { mode });
  } catch (e) {
    if (e instanceof TeamkitError && e.status === 429 && e.code === "rate_limited") {
      const wait = e.retryAfterSeconds;
      throw new CliExit(
        1,
        wait === undefined
          ? "Too many login attempts; try again shortly."
          : `Too many login attempts; try again in ${wait} s.`,
      );
    }
    throw e;
  }
}
