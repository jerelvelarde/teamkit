import pkg from "../package.json" with { type: "json" };

/** The CLI's version, compiled in so the bundled CLI needs no package.json beside it. */
export const VERSION: string = pkg.version;
