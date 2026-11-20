"use client";

import { useParams } from "next/navigation";
import { ThreadView } from "../../../../../components/ThreadView";

export default function ThreadPage() {
  const params = useParams<{ id: string }>();
  return <ThreadView id={params.id} />;
}
