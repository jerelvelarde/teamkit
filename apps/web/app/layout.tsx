import type { ReactNode } from "react";
import "./globals.css";
import { BlurCircles } from "../components/BlurCircles";
import { Header } from "../components/Header";
import shell from "../components/shell.module.css";

export const metadata = { title: "AG-UI TeamKit" };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@300;400;500;600;700&family=Spline+Sans+Mono:wght@400;500;600&display=swap"
          rel="stylesheet"
        />
      </head>
      <body>
        <div className={`tk-shell ${shell.shell}`}>
          <BlurCircles />
          <Header />
          <main className={shell.main}>{children}</main>
        </div>
      </body>
    </html>
  );
}
