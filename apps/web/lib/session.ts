"use client";

import { useCallback, useEffect, useState } from "react";
import type { Whoami } from "@copilotkit/teamkit-protocol";
import { getJson } from "./api";

export interface SessionState {
  state: "loading" | "signed_out" | "signed_in";
  who: Whoami | null;
  refresh(): void;
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
      () => {
        // Any failure (401, a missing route, a network error) reads as signed out.
        if (!live) return;
        setWho(null);
        setState("signed_out");
      },
    );
    return () => {
      live = false;
    };
  }, [tick]);

  return { state, who, refresh };
}
