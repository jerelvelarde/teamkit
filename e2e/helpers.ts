import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

/** Absolute path of the repository root, for end-to-end tests that start the server or run the CLI. */
export const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
