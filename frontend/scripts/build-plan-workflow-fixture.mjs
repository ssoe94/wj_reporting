/** Local fixture build only: no .env loading, install, API call or deployment. */
import { build } from 'vite';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';

const frontend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repo = path.dirname(frontend);
const outDir = path.join(repo, 'output', 'plan-workflow-dist');
process.env.VITE_ENABLE_DEV_LOGIN = 'false';
process.env.VITE_USE_REMOTE_PRODUCTION_API = 'true';
process.env.VITE_API_BASE_URL = 'http://127.0.0.1:5198/api';

function run(command, args) {
  const result = spawnSync(command, args, { cwd: frontend, stdio: 'inherit', shell: false });
  if (result.error || result.status !== 0) throw new Error(`Fixture build step failed: ${command}`);
}

mkdirSync(path.join(repo, 'output'), { recursive: true });
for (const name of ['app', 'node']) {
  run(process.execPath, ['node_modules/typescript/bin/tsc', '-p', `tsconfig.${name}.json`,
    '--incremental', '--tsBuildInfoFile', path.join(repo, 'output', `plan-workflow-${name}.tsbuildinfo`)]);
}
// Reused node_modules may be read-only; keep all generated caches in this worktree.
globalThis.__dirname = frontend;
await build({ root: frontend, configLoader: 'runner', envFile: false,
  cacheDir: path.join(repo, 'output', 'plan-workflow-vite-cache'),
  build: { outDir, emptyOutDir: true } });
run(process.execPath, ['node_modules/postcss-cli/index.js', 'src/legacy.css', '--config', './config/postcss-legacy', '-o', path.join(outDir, 'legacy.css')]);
const sha = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8', shell: false });
if (sha.status !== 0) throw new Error('Cannot identify fixture build source');
writeFileSync(path.join(outDir, 'build-info.json'), JSON.stringify({
  commit: sha.stdout.trim(), fixture: true, uncommitted: true,
  builtAt: new Date().toISOString(), api: 'loopback fixtures only',
}) + '\n');
console.log(`Plan workflow full application fixture build: ${outDir}`);
