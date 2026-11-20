import type { ReactNode } from "react";
import { Inter } from "next/font/google";
import "./globals.css";

// Self-hosted at build time: the page makes no request to a font host.
const inter = Inter({ subsets: ["latin"], display: "swap", variable: "--tk-font-inter" });

export const metadata = { title: "AG-UI TeamKit" };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={inter.variable}>
      <body>{children}</body>
    </html>
  );
}
