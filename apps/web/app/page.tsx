"use client";

import { Suspense } from "react";
import { Board } from "../components/Board";
import { SignedOut } from "../components/SignedOut";
import { useWhoami } from "../lib/session";

export default function Page() {
  const { state } = useWhoami();
  if (state === "loading") return null;
  if (state === "signed_out") return <SignedOut />;
  return (
    <Suspense fallback={null}>
      <Board />
    </Suspense>
  );
}
