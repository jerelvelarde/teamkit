import { Suspense } from "react";
import { DeviceApprove } from "../../../components/DeviceApprove";

export default function DevicePage() {
  return (
    <Suspense fallback={null}>
      <DeviceApprove />
    </Suspense>
  );
}
