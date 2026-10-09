import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const require = createRequire(new URL('../frontend/package.json', import.meta.url));
const ts = require('typescript');
const SHA = /^[0-9a-f]{40}$/;
const WORKFLOW = '.github/workflows/test-and-deploy.yml';
const nativeTag = /^[a-z][a-z0-9]*$/;
const presentationAttributes = new Set(['className', 'title', 'aria-label', 'aria-description']);

function simpleValue(node) {
  if (!node) return false;
  if (ts.isStringLiteral(node) || ts.isNumericLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return true;
  if (ts.isIdentifier(node)) return true;
  if (ts.isTemplateExpression(node)) return node.templateSpans.every(span => simpleValue(span.expression));
  return false;
}

function staticStyle(node) {
  return ts.isObjectLiteralExpression(node) && node.properties.every(property =>
    ts.isPropertyAssignment(property)
    && (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name))
    && (ts.isStringLiteral(property.initializer) || ts.isNumericLiteral(property.initializer)
      || (ts.isPrefixUnaryExpression(property.initializer)
        && property.initializer.operator === ts.SyntaxKind.MinusToken
        && ts.isNumericLiteral(property.initializer.operand))));
}

function removableAttribute(attribute) {
  if (!ts.isJsxAttribute(attribute) || !ts.isIdentifier(attribute.name)) return false;
  if (!attribute.initializer) return false;
  const value = ts.isJsxExpression(attribute.initializer) ? attribute.initializer.expression : attribute.initializer;
  if (!value) return false;
  if (attribute.name.text === 'style') return staticStyle(value);
  return presentationAttributes.has(attribute.name.text) && simpleValue(value);
}

/** Compare executable structure, ignoring only text and safe native JSX presentation attributes. */
export function presentationEquivalent(before, after, filename = 'screen.tsx') {
  const fingerprint = text => {
    const source = ts.createSourceFile(filename, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    if (source.parseDiagnostics.length) throw new Error('Invalid TSX');
    const transformed = ts.transform(source, [context => {
      const visit = node => {
        if (ts.isJsxText(node)) return context.factory.createJsxText('');
        if (ts.isJsxExpression(node) && node.expression && ts.isStringLiteral(node.expression)
          && (ts.isJsxElement(node.parent) || ts.isJsxFragment(node.parent))) {
          return context.factory.createJsxExpression(undefined, context.factory.createStringLiteral(''));
        }
        if (ts.isJsxAttributes(node) && nativeTag.test(node.parent.tagName.getText(source))) {
          return context.factory.updateJsxAttributes(node, node.properties.filter(attribute => !removableAttribute(attribute)));
        }
        return ts.visitEachChild(node, visit, context);
      };
      return node => ts.visitNode(node, visit);
    }]);
    try {
      return ts.createPrinter({ removeComments: true }).printFile(transformed.transformed[0]);
    } finally {
      transformed.dispose();
    }
  };
  try { return fingerprint(before) === fingerprint(after); } catch { return false; }
}

function safePath(path) {
  return typeof path === 'string' && path.startsWith('frontend/')
    && !path.split('/').some(segment => !segment || segment === '.' || segment === '..')
    && !/[\x00-\x1f\\]/.test(path);
}

function isPresentationFile(path) {
  // Entry points, auth, API clients, hooks, contracts, dependencies and configs are never inferred as UI-only.
  if (/(?:auth|permission|login|password|oauth|token|security|route|provider|context)/i.test(path)) return false;
  return /^frontend\/src\/(?:pages\/|components\/|domains\/[^/]+\/(?:pages|components)\/).+\.tsx$/.test(path);
}

export function classifyChanges(changes, readSource) {
  if (!changes.length) return { mode: 'full', reason: 'No classifiable changes' };
  for (const change of changes) {
    const { status, path } = change;
    if (!['A', 'M'].includes(status) || !safePath(path) || change.mode !== '100644') {
      return { mode: 'full', reason: `Non-UI file operation: ${path}` };
    }
    if (/^frontend\/src\/.+\.css$/.test(path)) continue;
    if (/^frontend\/(?:src\/assets|public)\/.+\.(?:png|jpe?g|webp|gif|avif|ico|woff2?)$/.test(path)) continue;
    if (status === 'M' && isPresentationFile(path)) {
      try {
        const { before, after } = readSource(path);
        if (presentationEquivalent(before, after, path)) continue;
      } catch { /* Missing source is full validation. */ }
    }
    return { mode: 'full', reason: `Code or contract change: ${path}` };
  }
  return { mode: 'ui', reason: 'Only styles, images/fonts and static JSX presentation changed' };
}

function git(repository, args) {
  return execFileSync('git', ['-C', repository, ...args], { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
}

function validCommit(repository, sha) {
  return SHA.test(sha ?? '') && !/^0+$/.test(sha)
    && git(repository, ['rev-parse', '--verify', `${sha}^{commit}`]).trim() === sha;
}

function ancestor(repository, base, head) {
  if (!validCommit(repository, base) || !validCommit(repository, head)) throw new Error('Missing commit');
  git(repository, ['merge-base', '--is-ancestor', base, head]);
}

function classifyRange(repository, base, head) {
  ancestor(repository, base, head);
  const fields = git(repository, ['diff', '--no-renames', '--name-status', '-z', base, head]).split('\0');
  if (fields.pop() !== '' || fields.length % 2) throw new Error('Invalid diff');
  const changes = [];
  for (let index = 0; index < fields.length; index += 2) {
    const path = fields[index + 1];
    const tree = git(repository, ['ls-tree', '-z', head, '--', path]);
    changes.push({ status: fields[index], path, mode: tree.slice(0, 6) });
  }
  // A previously deployed commit can equal HEAD; it contributes no additional risk.
  if (base === head) return { mode: 'ui', reason: 'No additional deployment delta' };
  return classifyChanges(changes, path => ({
    before: git(repository, ['show', `${base}:${path}`]),
    after: git(repository, ['show', `${head}:${path}`]),
  }));
}

/** All uncertain events/history/evidence fail closed to the complete existing suite. */
export async function determineScope({ repository, eventName, event, head, loadDeploymentEvidence }) {
  try {
    if (!validCommit(repository, head) || git(repository, ['rev-parse', 'HEAD']).trim() !== head) throw new Error('Checkout mismatch');
    if (eventName === 'pull_request') {
      if (event.pull_request?.head?.sha !== head || event.pull_request?.base?.ref !== 'main') throw new Error('Invalid PR range');
      const base = event.pull_request.base.sha;
      if (!validCommit(repository, base)) throw new Error('Missing PR base');
      const mergeBase = git(repository, ['merge-base', base, head]).trim();
      return classifyRange(repository, mergeBase, head);
    }
    if (eventName !== 'push') return { mode: 'full', reason: 'Manual or unknown event uses full validation' };
    if (event.ref !== 'refs/heads/main' || event.after !== head || event.forced === true) throw new Error('Invalid push range');
    const change = classifyRange(repository, event.before, head);
    if (change.mode !== 'ui') return change;
    const evidence = await loadDeploymentEvidence();
    // before..HEAD alone misses backend commits from canceled/failed earlier pushes.
    for (const base of [evidence.validatedBackend, evidence.deployedFrontend]) {
      const catchup = classifyRange(repository, base, head);
      if (catchup.mode !== 'ui') return { mode: 'full', reason: `Pending deployment: ${catchup.reason}` };
    }
    return { mode: 'ui', reason: 'UI-only push; successful full-deploy and live frontend baselines checked' };
  } catch {
    return { mode: 'full', reason: 'Change range or deployment evidence unavailable; using full validation' };
  }
}

export async function loadDeploymentEvidence({ repository, token, request = fetch }) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository ?? '') || !token) throw new Error('Missing Actions identity');
  const json = async (url, authenticated = false) => {
    const response = await request(url, {
      signal: AbortSignal.timeout(10_000),
      headers: authenticated ? { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`, 'X-GitHub-Api-Version': '2022-11-28' } : { 'Cache-Control': 'no-cache' },
    });
    if (!response.ok) throw new Error('Deployment evidence request failed');
    return response.json();
  };
  const api = `https://api.github.com/repos/${repository}`;
  const [build, result] = await Promise.all([
    json(`https://wj-reporting.onrender.com/build-info.json?ci=${Date.now()}`),
    json(`${api}/actions/workflows/test-and-deploy.yml/runs?branch=main&status=success&per_page=20`, true),
  ]);
  if (build.branch !== 'main' || !SHA.test(build.commit ?? '') || !Array.isArray(result.workflow_runs)) throw new Error('Invalid deployment evidence');
  const candidates = result.workflow_runs.filter(run =>
    Number.isSafeInteger(run.id) && run.head_branch === 'main' && run.conclusion === 'success'
    && ['push', 'workflow_dispatch'].includes(run.event) && run.path === WORKFLOW
    && run.repository?.full_name === repository && SHA.test(run.head_sha ?? '')).slice(0, 20);
  // Read-only, bounded discovery. After 20 UI releases without a full baseline, run the full suite again.
  for (const run of candidates) {
    const result = await json(`${api}/actions/runs/${run.id}/jobs?per_page=100`, true);
    if (!Array.isArray(result.jobs) || !Number.isSafeInteger(result.total_count)
      || result.total_count < 0 || result.total_count !== result.jobs.length) throw new Error('Incomplete job evidence');
    const deployed = result.jobs.some(job => job.name === 'Deploy production from main' && job.conclusion === 'success'
      && job.steps?.some(step => step.name === 'Deploy production backend' && step.conclusion === 'success'));
    const verified = result.jobs.some(job => job.name === 'Verify production deployment' && job.conclusion === 'success');
    if (deployed && verified) return { validatedBackend: run.head_sha, deployedFrontend: build.commit };
  }
  throw new Error('No successful full production deployment baseline');
}

async function main() {
  let scope;
  try {
    const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
    scope = await determineScope({
      repository: process.cwd(), eventName: process.env.GITHUB_EVENT_NAME, event,
      head: process.env.GITHUB_EVENT_NAME === 'pull_request' ? event.pull_request?.head?.sha : process.env.GITHUB_SHA,
      loadDeploymentEvidence: () => loadDeploymentEvidence({ repository: process.env.GITHUB_REPOSITORY, token: process.env.GH_TOKEN }),
    });
  } catch {
    scope = { mode: 'full', reason: 'Missing event context; using full validation' };
  }
  const backendRequired = scope.mode !== 'ui';
  console.log(JSON.stringify({ ...scope, backendRequired }));
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `backend_required=${backendRequired}\nmode=${scope.mode}\n`);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY,
    `### Validation scope: ${scope.mode === 'ui' ? 'UI fast path' : 'Full regression'}\n\nFrontend lint, contract tests and modern/legacy builds always run. Backend regression and deployment: **${backendRequired ? 'required' : 'not needed'}**.\n\n${scope.reason.replace(/[\r\n`<>]/g, ' ')}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
