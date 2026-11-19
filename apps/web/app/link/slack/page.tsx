import { Suspense } from "react";
import { SlackLink } from "../../../components/SlackLink";

export default function SlackLinkPage() {
  return (
    <Suspense fallback={null}>
      <SlackLink />
    </Suspense>
  );
}
