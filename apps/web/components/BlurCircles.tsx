import styles from "./shell.module.css";

const CIRCLES: Array<{ size: number; left: number; top: number; background: string }> = [
  { size: 446, left: 1040, top: 11, background: "rgba(255, 172, 77, 0.2)" },
  { size: 609, left: 1339, top: 625, background: "#C9C9DA" },
  { size: 609, left: 670, top: -365, background: "#C9C9DA" },
  { size: 609, left: 508, top: 702, background: "#F3F3FC" },
  { size: 446, left: 128, top: 331, background: "rgba(255, 243, 136, 0.3)" },
  { size: 446, left: -205, top: 803, background: "rgba(255, 172, 77, 0.2)" },
];

export function BlurCircles() {
  return (
    <div aria-hidden="true">
      {CIRCLES.map((c) => (
        <div
          key={`${c.left}-${c.top}`}
          className={styles.circle}
          style={{ width: c.size, height: c.size, left: c.left, top: c.top, background: c.background }}
        />
      ))}
    </div>
  );
}
