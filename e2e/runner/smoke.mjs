/**
 * npm run smoke — the orchestrator behind the CI gate.
 *
 * Phase 1  : all generated specs via `npx playwright test` (deterministic).
 * Phase 1b : agentic-only scenarios via the agentic runner.
 * Phase 2  : failed generated scenarios re-run agentically (fallback) to
 *            classify: spec-rot-suspected vs regression-confirmed.
 * Phase 3  : run summary + Markdown report (artifacts/smoke-report.md).
 *
 * Exit codes (CI treats 1/2/3 as failure):
 *   0 — everything passed (skips are fine)
 *   1 — at least one real/unverified regression
 *   2 — ONLY spec-rot failures (app works, spec(s) stale — regenerate)
 *   3 — infra/harness error (stack unreachable, login setup failed, ...)
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
import {
  ARTIFACTS_DIR,
  E2E_ROOT,
  ensureDir,
  effectiveMode,
  isSupported,
  loadConfig,
  loadDotEnv,
  loadScenarios,
  readJsonSafe,
  stackCapabilities,
} from './scenarios.mjs';
import { runAgenticScenario } from './agentic.mjs';
import { writeReport } from './analyze.mjs';

const PW_REPORT = path.join(ARTIFACTS_DIR, 'pw-report.json');
const SUMMARY_FILE = path.join(ARTIFACTS_DIR, 'run-summary.json');

function exitInfra(msg) {
  console.error(`[smoke] INFRA ERROR: ${msg}`);
  process.exit(3);
}

async function probe(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    return res.ok || (res.status >= 300 && res.status < 500);
  } catch {
    return false;
  }
}

function runPlaywright(specFiles) {
  // Drive the Playwright CLI with the current node binary — no npx, no
  // shell, and forward-slash paths (backslashes break Playwright's
  // file-pattern matching on Windows).
  const cli = require.resolve('@playwright/test/cli');
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cli, 'test', ...specFiles], {
      cwd: E2E_ROOT,
      stdio: 'inherit',
    });
    child.on('close', (code) => resolve(code ?? 1));
    child.on('error', () => resolve(1));
  });
}

/** Flatten the Playwright JSON report into per-spec-file outcomes. */
function parsePwReport(report) {
  const byFile = new Map(); // file basename -> { passed, error, screenshots }
  const walk = (suite, fileFromParent) => {
    const file = suite.file || fileFromParent;
    for (const spec of suite.specs || []) {
      const key = path.basename(spec.file || file || '');
      const entry = byFile.get(key) || { passed: true, error: '', screenshots: [] };
      // spec.ok is false when any test in the spec failed (after retries).
      if (spec.ok === false) entry.passed = false;
      for (const t of spec.tests || []) {
        for (const r of t.results || []) {
          if (r.status !== 'passed' && r.error?.message && !entry.error) {
            // Strip full ANSI SGR escapes, including the leading ESC byte.
            entry.error = String(r.error.message).replace(/\u001b\[[0-9;]*m/g, '');
          }
          for (const a of r.attachments || []) {
            if (a.contentType === 'image/png' && a.path) entry.screenshots.push(a.path);
          }
        }
      }
      byFile.set(key, entry);
    }
    for (const s of suite.suites || []) walk(s, file);
  };
  for (const s of report.suites || []) walk(s, null);
  return byFile;
}

async function main() {
  loadDotEnv();
  const cfg = loadConfig();
  const baseUrl = process.env.BASE_URL || 'http://localhost:5176';
  const startedAt = new Date().toISOString();
  ensureDir(ARTIFACTS_DIR);

  // ── Preflight ──────────────────────────────────────────────────────────
  if (!(await probe(baseUrl))) exitInfra(`frontend unreachable at ${baseUrl}`);
  if (!process.env.ADMIN_PASSWORD) exitInfra('ADMIN_PASSWORD is not set');

  const capabilities = stackCapabilities();
  const only = process.env.E2E_SCENARIO;
  let scenarios = loadScenarios();
  if (only) {
    scenarios = scenarios.filter((s) => s.id === only);
    if (scenarios.length === 0) exitInfra(`E2E_SCENARIO '${only}' does not exist`);
  }

  const rows = scenarios.map((s) => ({
    id: s.id,
    title: s.title,
    mode: s.mode,
    effectiveMode: effectiveMode(s, cfg),
    result: 'pending',
    classification: null,
    errorExcerpt: '',
    screenshots: [],
    fallback: null,
    skippedReason: null,
    scenario: s,
  }));

  for (const r of rows) {
    if (!isSupported(r.scenario, capabilities)) {
      r.result = 'skipped';
      r.classification = null;
      r.skippedReason = `requires [${r.scenario.requires.join(', ')}], stack offers [${(capabilities || []).join(', ')}]`;
      console.log(`[smoke] SKIP ${r.id} — ${r.skippedReason}`);
    }
  }

  const active = rows.filter((r) => r.result !== 'skipped');
  const genRows = active.filter((r) => r.effectiveMode.includes('generated'));
  const agenticRows = active.filter((r) => r.effectiveMode === 'agentic');

  // ── Phase 1: deterministic Playwright run ───────────────────────────────
  if (genRows.length > 0) {
    const specFiles = genRows.map((r) => `tests/generated/${r.id}.spec.ts`);
    const missing = specFiles.filter((f) => !fs.existsSync(path.join(E2E_ROOT, f)));
    if (missing.length) exitInfra(`missing generated spec(s): ${missing.join(', ')} — run npm run gen`);

    console.log(`[smoke] phase 1 — playwright: ${genRows.map((r) => r.id).join(', ')}`);
    if (fs.existsSync(PW_REPORT)) fs.rmSync(PW_REPORT);
    await runPlaywright(specFiles);

    const report = readJsonSafe(PW_REPORT);
    if (!report) {
      exitInfra('playwright produced no JSON report — likely a global-setup/login failure (see output above)');
    }
    if ((report.errors || []).length && !(report.suites || []).length) {
      exitInfra(`playwright global error: ${JSON.stringify(report.errors[0]).slice(0, 400)}`);
    }
    const byFile = parsePwReport(report);
    for (const r of genRows) {
      const entry = byFile.get(`${r.id}.spec.ts`);
      if (!entry) {
        r.result = 'fail';
        r.errorExcerpt = 'spec did not run (no result in Playwright report)';
      } else {
        r.result = entry.passed ? 'pass' : 'fail';
        r.errorExcerpt = entry.error;
        r.screenshots = entry.screenshots.slice(0, 2);
      }
    }
  }

  // ── Phase 1b: agentic-only scenarios ────────────────────────────────────
  // Without an API key agentic scenarios cannot run at all. Locally that is
  // a skip; in CI the workflow marks the secret as required, so a missing
  // key cannot silently weaken the gate there.
  const hasApiKey = Boolean(process.env.ANTHROPIC_API_KEY);
  for (const r of agenticRows) {
    if (!hasApiKey) {
      r.result = 'skipped';
      r.skippedReason = 'ANTHROPIC_API_KEY not set — agentic scenario cannot run';
      console.warn(`[smoke] SKIP ${r.id} — ${r.skippedReason}`);
      continue;
    }
    console.log(`[smoke] phase 1b — agentic: ${r.id}`);
    try {
      const { verdict, artifactsDir } = await runAgenticScenario(r.scenario);
      r.result = verdict.verdict === 'pass' ? 'pass' : 'fail';
      r.fallback = verdict;
      r.errorExcerpt = verdict.verdict === 'pass' ? '' : verdict.summary;
      r.screenshots = (verdict.evidence || []).slice(-2).map((f) => path.join(artifactsDir, f));
      if (r.result === 'fail') r.classification = 'regression-confirmed';
    } catch (e) {
      if (e.infra) exitInfra(e.message);
      r.result = 'fail';
      r.classification = 'regression-unverified';
      r.errorExcerpt = String(e.message || e).slice(0, 400);
    }
  }

  // ── Phase 2: agentic fallback for failed generated scenarios ────────────
  const fallbackCandidates = genRows.filter(
    (r) => r.result === 'fail' && r.effectiveMode === 'generated+agentic-fallback',
  );
  const fallbackEnabled = cfg.fallback?.enabled !== false;
  const fallbackCap = cfg.fallback?.maxScenarios ?? 4;
  let fallbackBudget = fallbackCap;

  for (const r of genRows.filter((x) => x.result === 'fail')) {
    if (!fallbackEnabled || !hasApiKey || !fallbackCandidates.includes(r) || fallbackBudget <= 0) {
      r.classification = 'regression-unverified';
      continue;
    }
    fallbackBudget -= 1;
    console.log(`[smoke] phase 2 — agentic fallback: ${r.id}`);
    try {
      const { verdict, artifactsDir } = await runAgenticScenario(r.scenario);
      r.fallback = verdict;
      r.classification = verdict.verdict === 'pass' ? 'spec-rot-suspected' : 'regression-confirmed';
      r.screenshots.push(...(verdict.evidence || []).slice(-1).map((f) => path.join(artifactsDir, f)));
    } catch (e) {
      // A broken fallback must not mask the real test failure — leave the
      // scenario as an unverified regression and keep going.
      console.warn(`[smoke] fallback for ${r.id} errored: ${String(e.message || e).slice(0, 200)}`);
      r.classification = 'regression-unverified';
      r.errorExcerpt = r.errorExcerpt || String(e.message || e).slice(0, 400);
    }
  }
  const skippedByBudget = fallbackCandidates.length - (fallbackCap - fallbackBudget);
  if (skippedByBudget > 0) {
    console.warn(`[smoke] fallback budget exhausted — ${skippedByBudget} failure(s) left unverified`);
  }

  // ── Phase 3: summary + report ────────────────────────────────────────────
  const summary = {
    startedAt,
    endedAt: new Date().toISOString(),
    baseUrl,
    scenarios: rows.map(({ scenario, ...rest }) => rest),
  };
  fs.writeFileSync(SUMMARY_FILE, JSON.stringify(summary, null, 2));
  const reportFile = await writeReport(summary, cfg);

  console.log('\n[smoke] ── results ─────────────────────────────');
  for (const r of rows) {
    const cls = r.result === 'fail' && r.classification ? ` (${r.classification})` : '';
    console.log(`[smoke] ${r.result.toUpperCase().padEnd(7)} ${r.id}${cls}`);
  }
  console.log(`[smoke] report: ${reportFile}`);

  const failures = rows.filter((r) => r.result === 'fail');
  const regressions = failures.filter((r) => r.classification !== 'spec-rot-suspected');
  if (regressions.length > 0) process.exit(1);
  if (failures.length > 0) {
    console.error(
      '[smoke] failing with exit 2: only spec-rot failures — the app works, but generated spec(s) are stale. ' +
        `Fix: cd e2e && npm run gen -- ${failures.map((f) => f.id).join(' ')}`,
    );
    process.exit(2);
  }
  process.exit(0);
}

main().catch((e) => {
  console.error(`[smoke] unexpected harness error: ${e?.stack || e}`);
  process.exit(3);
});
