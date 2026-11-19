"use client";

import { useParams } from "next/navigation";
import { SignedOut } from "../../../components/SignedOut";
import { ThreadView } from "../../../components/ThreadView";
import { useWhoami } from "../../../lib/session";

export default function ThreadPage() {
  const params = useParams<{ id: string }>();
  const { state } = useWhoami();
  if (state === "loading") return null;
  if (state === "signed_out") return <SignedOut />;
  return <ThreadView id={params.id} />;
}
