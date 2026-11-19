import type { SVGProps } from "react";
import type { TaskState } from "@copilotkit/teamkit-protocol";

type IconProps = SVGProps<SVGSVGElement> & { size?: number };

function Svg({ size = 16, children, ...rest }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      {children}
    </svg>
  );
}

export const IconAlert = (p: IconProps) => (
  <Svg {...p}>
    <path d="M7.13 2.5a1 1 0 0 1 1.74 0l5.4 9.5a1 1 0 0 1-.87 1.5H2.6a1 1 0 0 1-.87-1.5z" />
    <path d="M8 6.25v3M8 11.25v.01" />
  </Svg>
);

export const IconRollCall = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="6" cy="5.5" r="2.25" />
    <path d="M2.5 13c.4-2.2 1.8-3.5 3.5-3.5s3.1 1.3 3.5 3.5" />
    <path d="M10.5 3.6a2.25 2.25 0 0 1 0 4.3M11.5 9.7c1.2.4 2 1.6 2.25 3.3" />
  </Svg>
);

export const IconPlus = (p: IconProps) => (
  <Svg {...p}>
    <path d="M8 3.25v9.5M3.25 8h9.5" />
  </Svg>
);

export const IconX = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 4l8 8M12 4l-8 8" />
  </Svg>
);

export const IconHash = (p: IconProps) => (
  <Svg {...p}>
    <path d="M6.25 2.5L5 13.5M11 2.5L9.75 13.5M2.75 6h11M2.25 10h11" />
  </Svg>
);

export const IconBoard = (p: IconProps) => (
  <Svg {...p}>
    <rect x="2.25" y="2.75" width="11.5" height="10.5" rx="2" />
    <path d="M6 2.75v10.5M10 2.75v6.5" />
  </Svg>
);

export const IconSettings = (p: IconProps) => (
  <Svg {...p}>
    <path d="M2.5 4.5h6M11.5 4.5h2M2.5 11.5h2M7.5 11.5h6" />
    <circle cx="10" cy="4.5" r="1.5" />
    <circle cx="6" cy="11.5" r="1.5" />
  </Svg>
);

export const IconSignOut = (p: IconProps) => (
  <Svg {...p}>
    <path d="M9.5 3H4.25c-.7 0-1.25.55-1.25 1.25v7.5c0 .7.55 1.25 1.25 1.25H9.5" />
    <path d="M7 8h6.5M11 5.5L13.5 8 11 10.5" />
  </Svg>
);

export const IconSend = (p: IconProps) => (
  <Svg {...p}>
    <path d="M8 13V3.5M4 7.25L8 3.25l4 4" />
  </Svg>
);

export const IconMenu = (p: IconProps) => (
  <Svg {...p}>
    <path d="M2.75 4.5h10.5M2.75 8h10.5M2.75 11.5h10.5" />
  </Svg>
);

export const IconTool = (p: IconProps) => (
  <Svg {...p}>
    <path d="M9.6 3.1a3 3 0 00-3.85 3.85L2.9 9.8a1.4 1.4 0 002 2l2.85-2.85a3 3 0 003.85-3.85L9.9 6.8 8.3 6.6 8.1 5z" />
  </Svg>
);

export const IconThought = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3 7.25a5 4 0 1110 0 5 4 0 01-7.1 3.6L3 12.25l.65-2.55A3.7 3.7 0 013 7.25z" />
  </Svg>
);

export const IconChevron = (p: IconProps) => (
  <Svg {...p}>
    <path d="M6 4l4 4-4 4" />
  </Svg>
);

export const IconLink = (p: IconProps) => (
  <Svg {...p}>
    <path d="M6.75 9.25l2.5-2.5M7.4 4.6l.85-.85a2.47 2.47 0 013.5 3.5l-.85.85M8.6 11.4l-.85.85a2.47 2.47 0 01-3.5-3.5l.85-.85" />
  </Svg>
);

/**
 * Linear-style status glyph. Waiting and ready are outlines (nothing is happening yet),
 * claimed is half full, and the end states are solid.
 */
export function StatusIcon({ state, size = 14 }: { state: TaskState; size?: number }) {
  const common = { width: size, height: size, viewBox: "0 0 14 14", "aria-hidden": true, focusable: false } as const;
  switch (state) {
    case "waiting":
      return (
        <svg {...common} fill="none">
          <circle cx="7" cy="7" r="5.75" stroke="var(--tk-fg-4)" strokeWidth="1.5" strokeDasharray="2.2 2.05" />
        </svg>
      );
    case "ready":
      return (
        <svg {...common} fill="none">
          <circle cx="7" cy="7" r="5.75" stroke="var(--tk-fg-3)" strokeWidth="1.5" />
        </svg>
      );
    case "claimed":
      return (
        <svg {...common} fill="none">
          <circle cx="7" cy="7" r="5.75" stroke="var(--tk-claimed)" strokeWidth="1.5" />
          <path d="M7 3.5a3.5 3.5 0 010 7z" fill="var(--tk-claimed)" />
        </svg>
      );
    case "blocked":
      return (
        <svg {...common} fill="none">
          <circle cx="7" cy="7" r="6.5" fill="var(--tk-blocked)" />
          <path d="M7 3.9v3.6" stroke="#fff" strokeWidth="1.6" strokeLinecap="round" />
          <circle cx="7" cy="9.85" r="0.95" fill="#fff" />
        </svg>
      );
    case "completed":
      return (
        <svg {...common} fill="none">
          <circle cx="7" cy="7" r="6.5" fill="var(--tk-done)" />
          <path d="M4.4 7.2l1.8 1.8 3.5-3.6" stroke="#fff" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      );
    case "failed":
      return (
        <svg {...common} fill="none">
          <circle cx="7" cy="7" r="6.5" fill="var(--tk-failed)" />
          <path d="M4.9 4.9l4.2 4.2M9.1 4.9L4.9 9.1" stroke="#fff" strokeWidth="1.6" strokeLinecap="round" />
        </svg>
      );
  }
}

export const STATE_LABEL: Record<TaskState, string> = {
  waiting: "Waiting",
  ready: "Ready",
  claimed: "Claimed",
  blocked: "Blocked",
  completed: "Done",
  failed: "Failed",
};
