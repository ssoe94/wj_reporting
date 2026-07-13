import { execFileSync } from "node:child_process";
import { copyFileSync, cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const frontendDir = resolve(repoRoot, "frontend");
const nextDir = resolve(repoRoot, "frontend-next");
const nextDistDir = resolve(nextDir, "dist");
const nextPublishDir = resolve(frontendDir, "dist", "next");
const npmCacheDir = resolve(tmpdir(), "wj-reporting-npm-cache");
const npmEnv = { npm_config_cache: npmCacheDir };

function run(command, args, cwd, env = {}) {
  const executable = process.platform === "win32" ? "cmd.exe" : command;
  const commandArgs = process.platform === "win32" ? ["/d", "/s", "/c", command, ...args] : args;
  execFileSync(executable, commandArgs, {
    cwd,
    env: { ...process.env, ...env },
    stdio: "inherit",
    shell: false,
  });
}

run("npm", ["install"], nextDir, npmEnv);
run("npm", ["run", "build"], nextDir, {
  ...npmEnv,
  VITE_API_BASE_URL: "/api",
  VITE_BASE_PATH: "/next/",
  VITE_MES_API_BASE_URL: "/api",
  VITE_USE_REMOTE_PRODUCTION_API: "true",
});

if (existsSync(nextPublishDir)) {
  rmSync(nextPublishDir, { recursive: true, force: true });
}
cpSync(nextDistDir, nextPublishDir, { recursive: true });

const nextIndex = join(nextPublishDir, "index.html");
for (const route of ["login", "production", "production/injection-board", "mes/monitoring"]) {
  const routeDir = join(nextPublishDir, route);
  mkdirSync(routeDir, { recursive: true });
  copyFileSync(nextIndex, join(routeDir, "index.html"));
}
