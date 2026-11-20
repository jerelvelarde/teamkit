import { Suspense } from "react";
import { JoinTeam } from "../../../../components/JoinTeam";

export default function JoinPage() {
  return (
    <Suspense fallback={null}>
      <JoinTeam />
    </Suspense>
  );
}
