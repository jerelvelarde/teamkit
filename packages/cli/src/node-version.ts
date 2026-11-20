/** Null when `version` is Node 22 or newer, else the one line to print before exiting. */
export function checkNodeVersion(version: string): string | null {
  const major = Number.parseInt(version.split(".")[0] ?? "", 10);
  if (Number.isFinite(major) && major >= 22) return null;
  return `TeamKit needs Node 22 or newer; this is Node ${version}. Install Node 22 and make sure the node on your PATH is that version.`;
}
