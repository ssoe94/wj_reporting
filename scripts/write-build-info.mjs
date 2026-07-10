import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const outputArg = process.argv[2];

if (!outputArg) {
  throw new Error("Usage: node scripts/write-build-info.mjs <output-directory>");
}

const outputDir = resolve(repoRoot, outputArg);
const buildInfo = {
  commit: process.env.RENDER_GIT_COMMIT || process.env.GITHUB_SHA || "local",
  branch: process.env.RENDER_GIT_BRANCH || process.env.GITHUB_REF_NAME || "local",
  builtAt: new Date().toISOString(),
};

mkdirSync(outputDir, { recursive: true });
writeFileSync(
  resolve(outputDir, "build-info.json"),
  `${JSON.stringify(buildInfo, null, 2)}\n`,
  "utf8",
);
