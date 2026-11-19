"use client";

import { Suspense } from "react";
import { Board } from "../components/Board";
import { ServerUnavailable, SignedOut } from "../components/SignedOut";
import { useWhoami } from "../lib/session";

export default function Page() {
  const { state, refresh } = useWhoami();
  if (state === "loading") return null;
  if (state === "signed_out") return <SignedOut />;
  if (state === "unavailable") return <ServerUnavailable onRetry={refresh} />;
  return (
    <Suspense fallback={null}>
      <Board />
    </Suspense>
  );
}
