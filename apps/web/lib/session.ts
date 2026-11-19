"use client";

import { useCallback, useEffect, useState } from "react";
import type { Whoami } from "@copilotkit/teamkit-protocol";
import { TeamkitError } from "@copilotkit/teamkit-client";
import { getJson } from "./api";

export interface SessionState {
  state: "loading" | "signed_out" | "signed_in" | "unavailable";
  who: Whoami | null;
  refresh(): void;
}

/** While the server is unavailable, ask again this often. */
const UNAVAILABLE_RETRY_MS = 5_000;

/**
 * Only a 401 means signed out. Anything else (a 502 while the server restarts, a network
 * error) says nothing about the session, so it reads as the server being unavailable.
 */
export function whoamiFailureState(err: unknown): "signed_out" | "unavailable" {
  return err instanceof TeamkitError && err.status === 401 ? "signed_out" : "unavailable";
}

export function useWhoami(): SessionState {
  const [state, setState] = useState<SessionState["state"]>("loading");
  const [who, setWho] = useState<Whoami | null>(null);
  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => setTick((n) => n + 1), []);

  useEffect(() => {
    let live = true;
    getJson<Whoami>("/v1/whoami").then(
      (w) => {
        if (!live) return;
        setWho(w);
        setState("signed_in");
      },
      (err: unknown) => {
        if (!live) return;
        const next = whoamiFailureState(err);
        if (next === "signed_out") setWho(null);
        setState(next);
      },
    );
    return () => {
      live = false;
    };
  }, [tick]);

  useEffect(() => {
    if (state !== "unavailable") return;
    const t = setTimeout(refresh, UNAVAILABLE_RETRY_MS);
    return () => clearTimeout(t);
  }, [state, tick, refresh]);

  return { state, who, refresh };
}
