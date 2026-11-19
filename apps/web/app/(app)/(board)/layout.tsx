import { Suspense } from "react";
import type { ReactNode } from "react";
import { Board } from "../../../components/Board";

/** The board stays mounted while a task opens and closes: `children` is the task panel, or nothing. */
export default function BoardLayout({ children }: { children: ReactNode }) {
  return (
    <Suspense fallback={null}>
      <Board>{children}</Board>
    </Suspense>
  );
}
