/**
 * npm run gen [-- <scenario-id> ...]
 *
 * Turns natural-language scenarios (scenarios/<id>.md) into committed
 * Playwright specs (tests/generated/<id>.spec.ts) via a single Anthropic
 * messages call per scenario. The spec embeds a scenario content hash;
 * gen-check.mjs enforces freshness in CI without needing an API key.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Anthropic from '@anthropic-ai/sdk';
import { lintSpec } from './lintSpec.mjs';
import {
  E2E_ROOT,
  GENERATED_DIR,
  PROMPT_VERSION,
  ensureDir,
  loadConfig,
  loadDotEnv,
  loadScenarios,
  scenarioHash,
  specPathFor,
} from './scenarios.mjs';

const APP_MAP_FILE = path.join(E2E_ROOT, 'context', 'app-map.md');
const PROMPT_FILE = path.join(E2E_ROOT, 'prompts', 'spec-generator.md');
const FIXTURES_FILE = path.join(E2E_ROOT, 'tests', 'fixtures.ts');
const MAX_ATTEMPTS = 2;

function sourceBlock(n, kind, title, body) {
  return `── Source ${n} (${kind}) — ${title} ──\n${body}\n`;
}

function extractTypescript(text) {
  const m = String(text).match(/```(?:typescript|ts)\s*\n([\s\S]*?)```/i);
  return m ? m[1].trim() : null;
}

// The linter lives in its own dependency-free module so it can be unit-tested
// without e2e/node_modules (this file imports the Anthropic SDK and gray-matter).
// Re-exported here because it used to be declared in this module.
export { lintSpec };

export function specHeader(scenario, appMap, model) {
  const appMapHash = scenarioHash(appMap).slice(0, 12);
  return [
    '// AUTO-GENERATED — DO NOT EDIT BY HAND.',
    `// Edit e2e/scenarios/${scenario.id}.md and run: npm run gen -- ${scenario.id}`,
    `// scenario-hash: sha256:${scenario.hash}`,
    `// prompt-version: ${PROMPT_VERSION}  app-map-hash: sha256:${appMapHash}  model: ${model}`,
    '',
  ].join('\n');
}

async function generateOne(client, cfg, scenario, appMap, systemPrompt, fixturesSrc) {
  const model = cfg.models?.generate || 'claude-sonnet-5';
  const userMessage = [
    sourceBlock(1, 'app_map', 'context/app-map.md', appMap),
    sourceBlock(2, 'scenario', `${scenario.id}.md`, scenario.raw),
    sourceBlock(3, 'fixtures', 'tests/fixtures.ts (import contract)', fixturesSrc),
  ].join('\n');

  const messages = [{ role: 'user', content: userMessage }];
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const resp = await client.messages.create({
      model,
      max_tokens: 8000,
      system: systemPrompt,
      messages,
    });
    const text = resp.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
    const code = extractTypescript(text);
    const problems = code ? lintSpec(code, scenario, appMap) : ['no ```typescript block in output'];
    if (code && problems.length === 0) {
      return { code, model };
    }
    console.warn(`[gen] ${scenario.id}: attempt ${attempt} rejected — ${problems.join('; ')}`);
    messages.push({ role: 'assistant', content: text });
    messages.push({
      role: 'user',
      content:
        `Your previous output violated the spec contract:\n- ${problems.join('\n- ')}\n\n` +
        'Regenerate the COMPLETE spec as a single ```typescript block, fixing every violation.',
    });
  }
  throw new Error(`[gen] ${scenario.id}: generation failed after ${MAX_ATTEMPTS} attempts`);
}

async function main() {
  loadDotEnv();
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error('[gen] ANTHROPIC_API_KEY is required for spec generation.');
    process.exit(3);
  }
  if (!fs.existsSync(APP_MAP_FILE)) {
    console.error(`[gen] missing ${APP_MAP_FILE} — the app map is required context.`);
    process.exit(3);
  }

  const cfg = loadConfig();
  const wanted = process.argv.slice(2).filter((a) => !a.startsWith('-'));
  const scenarios = loadScenarios().filter(
    (s) => s.mode.includes('generated') && (wanted.length === 0 || wanted.includes(s.id)),
  );
  const unknown = wanted.filter((w) => !scenarios.some((s) => s.id === w));
  if (unknown.length) {
    console.error(
      `[gen] unknown or non-generated scenario id(s): ${unknown.join(', ')} ` +
        '(agentic-only scenarios have no spec to generate)',
    );
    process.exit(1);
  }
  if (scenarios.length === 0) {
    console.log('[gen] nothing to generate.');
    return;
  }

  const appMap = fs.readFileSync(APP_MAP_FILE, 'utf8');
  const systemPrompt = fs.readFileSync(PROMPT_FILE, 'utf8');
  const fixturesSrc = fs.readFileSync(FIXTURES_FILE, 'utf8');
  const client = new Anthropic({ apiKey });
  ensureDir(GENERATED_DIR);

  for (const scenario of scenarios) {
    console.log(`[gen] generating ${scenario.id} ...`);
    const { code, model } = await generateOne(client, cfg, scenario, appMap, systemPrompt, fixturesSrc);
    const out = specHeader(scenario, appMap, model) + code + '\n';
    fs.writeFileSync(specPathFor(scenario.id), out, 'utf8');
    console.log(`[gen] wrote tests/generated/${scenario.id}.spec.ts`);
  }
  console.log('[gen] done. Review the diff, run the spec(s) headed, then commit scenario + spec together.');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(e.message || e);
    process.exit(1);
  });
}
