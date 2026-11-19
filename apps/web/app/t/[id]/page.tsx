"use client";

import { useParams } from "next/navigation";
import { ServerUnavailable, SignedOut } from "../../../components/SignedOut";
import { ThreadView } from "../../../components/ThreadView";
import { useWhoami } from "../../../lib/session";

export default function ThreadPage() {
  const params = useParams<{ id: string }>();
  const { state, refresh } = useWhoami();
  if (state === "loading") return null;
  if (state === "signed_out") return <SignedOut />;
  if (state === "unavailable") return <ServerUnavailable onRetry={refresh} />;
  return <ThreadView id={params.id} />;
}
