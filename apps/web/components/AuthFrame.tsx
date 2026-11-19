import type { ReactNode } from "react";
import styles from "./shell.module.css";

export function BrandMark() {
  return (
    <span className={styles.brand}>
      <span className={styles.mark} aria-hidden="true">
        TK
      </span>
      <span className={styles.brandName}>
        <span className={styles.brandPrefix}>AG-UI</span> TeamKit
      </span>
    </span>
  );
}

/** A narrow centered column for pages that sit outside the app: sign-in, device approval, Slack linking. */
export function AuthFrame({ children }: { children: ReactNode }) {
  return (
    <div className={styles.authFrame}>
      <div className={styles.authColumn}>
        <header className={styles.authBrand}>
          <BrandMark />
        </header>
        {children}
      </div>
    </div>
  );
}
