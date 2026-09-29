/**
 * npm run analyze — writes artifacts/smoke-report.md from the run summary
 * (artifacts/run-summary.json, produced by smoke.mjs).
 *
 * All-green runs are summarized locally (no API call). For failures, Claude
 * (models.analyze) turns the digest + failure screenshots into a readable
 * triage note; when no API key is available or the call fails, a plain local
 * report is written instead so the gate never depends on the analyst.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Anthropic from '@anthropic-ai/sdk';
import { ARTIFACTS_DIR, E2E_ROOT, ensureDir, loadConfig, loadDotEnv, readJsonSafe } from './scenarios.mjs';

const PROMPT_FILE = path.join(E2E_ROOT, 'prompts', 'failure-analyst.md');
const REPORT_FILE = path.join(ARTIFACTS_DIR, 'smoke-report.md');
const SUMMARY_FILE = path.join(ARTIFACTS_DIR, 'run-summary.json');
const MAX_IMAGES = 4;
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;

const RESULT_ICON = { pass: '✅ pass', fail: '❌ fail', skipped: '⏭ skipped' };

function resultTable(summary) {
  const rows = summary.scenarios.map(
    (s) =>
      `| ${s.id} | ${s.effectiveMode} | ${RESULT_ICON[s.result] || s.result} | ${
        s.classification && s.result === 'fail' ? `\`${s.classification}\`` : '-'
      } |`,
  );
  return ['| Scenario | Mode | Result | Classification |', '|---|---|---|---|', ...rows].join('\n');
}

/** Dependency-free fallback report (also the all-green report). */
export function localReport(summary) {
  const failed = summary.scenarios.filter((s) => s.result === 'fail');
  const head = failed.length === 0 ? '## E2E smoke — PASS' : '## E2E smoke — FAIL';
  const lines = [head, '', resultTable(summary), ''];
  if (failed.length === 0) {
    lines.push(`All ${summary.scenarios.filter((s) => s.result === 'pass').length} executed scenario(s) passed against ${summary.baseUrl}.`);
  } else {
    for (const s of failed) {
      lines.push(`### ${s.id} — ${s.classification}`);
      if (s.errorExcerpt) lines.push('', '```', s.errorExcerpt.slice(0, 800), '```');
      if (s.fallback?.summary) lines.push('', `Agentic re-run: **${s.fallback.verdict}** — ${s.fallback.summary}`);
      if (s.classification === 'spec-rot-suspected') {
        lines.push('', `Suggested fix: \`cd e2e && npm run gen -- ${s.id}\`, review the diff, commit both files.`);
      }
      lines.push('');
    }
  }
  return lines.join('\n') + '\n';
}

function digestFor(summary) {
  const compact = {
    baseUrl: summary.baseUrl,
    startedAt: summary.startedAt,
    endedAt: summary.endedAt,
    scenarios: summary.scenarios.map((s) => ({
      id: s.id,
      title: s.title,
      mode: s.effectiveMode,
      result: s.result,
      classification: s.classification,
      errorExcerpt: s.errorExcerpt ? s.errorExcerpt.slice(0, 1200) : undefined,
      fallback: s.fallback
        ? { verdict: s.fallback.verdict, summary: s.fallback.summary, failed_step: s.fallback.failed_step, reasoning: s.fallback.reasoning?.slice(0, 800) }
        : undefined,
      skippedReason: s.skippedReason,
    })),
  };
  return JSON.stringify(compact, null, 2);
}

function collectImages(summary) {
  const images = [];
  for (const s of summary.scenarios) {
    if (s.result !== 'fail') continue;
    for (const p of s.screenshots || []) {
      if (images.length >= MAX_IMAGES) return images;
      try {
        const abs = path.isAbsolute(p) ? p : path.join(E2E_ROOT, p);
        const buf = fs.readFileSync(abs);
        if (buf.length > MAX_IMAGE_BYTES) continue;
        images.push({ scenario: s.id, file: path.basename(abs), b64: buf.toString('base64') });
      } catch {
        // missing screenshot is not fatal
      }
    }
  }
  return images;
}

export async function writeReport(summary, cfg = null) {
  ensureDir(ARTIFACTS_DIR);
  cfg = cfg || loadConfig();
  const failed = summary.scenarios.filter((s) => s.result === 'fail');
  const apiKey = process.env.ANTHROPIC_API_KEY;

  let report = null;
  if (failed.length > 0 && apiKey) {
    try {
      const client = new Anthropic({ apiKey });
      const content = [
        {
          type: 'text',
          text:
            `Run digest (JSON):\n\`\`\`json\n${digestFor(summary)}\n\`\`\`\n\n` +
            'Failure screenshots follow (labelled per scenario). Write the report now.',
        },
      ];
      for (const img of collectImages(summary)) {
        content.push({ type: 'text', text: `Screenshot — scenario ${img.scenario} (${img.file}):` });
        content.push({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: img.b64 } });
      }
      const resp = await client.messages.create({
        model: cfg.models?.analyze || 'claude-haiku-4-5',
        max_tokens: 4000,
        system: fs.readFileSync(PROMPT_FILE, 'utf8'),
        messages: [{ role: 'user', content }],
      });
      report = resp.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
      if (report && !report.startsWith('##')) report = `## E2E smoke — FAIL\n\n${report}`;
    } catch (e) {
      console.warn(`[analyze] LLM analysis failed (${String(e.message || e).slice(0, 200)}) — writing local report.`);
    }
  }

  fs.writeFileSync(REPORT_FILE, report || localReport(summary), 'utf8');
  return REPORT_FILE;
}

async function cli() {
  loadDotEnv();
  const summary = readJsonSafe(SUMMARY_FILE);
  if (!summary) {
    console.error(`[analyze] no ${SUMMARY_FILE} — run npm run smoke first.`);
    process.exit(1);
  }
  const file = await writeReport(summary);
  console.log(`[analyze] wrote ${file}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  cli().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
