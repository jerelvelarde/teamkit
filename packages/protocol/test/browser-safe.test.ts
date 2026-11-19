import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "../src");
const SPECIFIER = /\b(?:import|export)\b[^;'"]*?\bfrom\s*["']([^"']+)["']|\bimport\s*["']([^"']+)["']/g;

function specifiers(source: string): string[] {
  return [...source.matchAll(SPECIFIER)].map((m) => (m[1] ?? m[2])!);
}

function reachable(entry: string): Map<string, string[]> {
  const seen = new Map<string, string[]>();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    const specs = specifiers(readFileSync(file, "utf8"));
    seen.set(file, specs);
    for (const spec of specs) {
      if (spec.startsWith(".")) queue.push(resolve(dirname(file), spec.replace(/\.js$/, ".ts")));
    }
  }
  return seen;
}

test("main entry reaches no node builtins", () => {
  const files = reachable(resolve(SRC, "index.ts"));
  assert.ok(files.size > 1);
  const builtins = new Set(builtinModules);
  for (const [file, specs] of files) {
    for (const spec of specs) {
      assert.ok(
        !spec.startsWith("node:") && !builtins.has(spec),
        `${file} imports ${spec}, which is not browser-safe`,
      );
    }
  }
});

test("main entry does not reach hash.ts", () => {
  const files = [...reachable(resolve(SRC, "index.ts")).keys()];
  assert.ok(!files.includes(resolve(SRC, "hash.ts")));
});
