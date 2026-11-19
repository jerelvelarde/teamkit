import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const REPO_ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "../../..");

/** Where the plugin's bundled CLI lives, committed. */
export const BUNDLE_PATH = join(REPO_ROOT, "plugins/teamkit/bin/teamkit.mjs");

// The require shim lets bundled CommonJS (commander, for one) load Node built-ins from ESM.
const BANNER = [
  "#!/usr/bin/env node",
  'import { createRequire as __teamkitCreateRequire } from "node:module";',
  "const require = __teamkitCreateRequire(import.meta.url);",
].join("\n");

/** Bundles the whole CLI into one executable ESM file. Builds are byte-identical wherever they run. */
export async function buildBundle(outfile: string): Promise<void> {
  // esbuild reads a relative outfile against absWorkingDir (the repo root); resolve it against the caller's directory first.
  const out = resolve(outfile);
  mkdirSync(dirname(out), { recursive: true });
  await build({
    entryPoints: ["packages/cli/src/entry.ts"],
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    minify: true,
    keepNames: true,
    legalComments: "eof",
    absWorkingDir: REPO_ROOT,
    logLevel: "warning",
    banner: { js: BANNER },
    outfile: out,
  });
  chmodSync(out, 0o755);
}

/** Whether `committed` has exactly the bytes a fresh build gives. */
export async function checkBundle(committed: string): Promise<{ fresh: boolean }> {
  const dir = mkdtempSync(join(tmpdir(), "teamkit-bundle-check-"));
  try {
    const fresh = join(dir, "teamkit.mjs");
    await buildBundle(fresh);
    let current: Buffer;
    try {
      current = readFileSync(committed);
    } catch {
      return { fresh: false };
    }
    return { fresh: current.equals(readFileSync(fresh)) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.includes("--check")) {
    if (!(await checkBundle(BUNDLE_PATH)).fresh) {
      process.stderr.write("plugins/teamkit/bin/teamkit.mjs is stale: run pnpm --filter @copilotkit/teamkit bundle and commit it\n");
      process.exit(1);
    }
  } else {
    await buildBundle(BUNDLE_PATH);
  }
}
