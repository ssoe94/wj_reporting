import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const frontendDir = resolve(repoRoot, "frontend");
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

run("npm", ["install"], frontendDir, npmEnv);
run("npm", ["run", "build"], frontendDir, npmEnv);
