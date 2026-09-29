/**
 * npm run agentic -- <scenario-id> [--headed]
 *
 * Mode 2: Claude drives a live Chromium through a small pw_* tool vocabulary
 * to execute one scenario, then reports a machine-readable verdict via the
 * report_verdict tool. Uses Anthropic-native shapes (this harness is
 * Anthropic-only).
 *
 * Security properties:
 * - credentials enter the page via {{USERNAME}}/{{PASSWORD}} placeholder
 *   substitution right before fill(); the real values are never in the model
 *   context, tool inputs, logs, or artifacts;
 * - same-origin guard at both the tool layer and the network layer;
 * - file uploads are whitelisted to e2e/fixtures-data/.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import Anthropic from '@anthropic-ai/sdk';
import {
  E2E_ROOT,
  ARTIFACTS_DIR,
  FIXTURES_DATA_DIR,
  ensureDir,
  loadConfig,
  loadDotEnv,
  loadScenarios,
} from './scenarios.mjs';
import { VERDICT_TOOL, validateVerdict, synthesizedFailure } from './verdict-schema.mjs';

const PROMPT_FILE = path.join(E2E_ROOT, 'prompts', 'agent-runner.md');
const APP_MAP_FILE = path.join(E2E_ROOT, 'context', 'app-map.md');
const SNAPSHOT_CAP = 8000;
const TEXT_CAP = 4000;
const TOOL_RESULT_CAP = 8000;

// Tools whose after-state Claude should see automatically. Read-only tools
// (pw_get_text, pw_snapshot) already return what the model asked for, so we
// don't append a second snapshot to them.
const OBSERVE_AFTER = new Set(['pw_navigate', 'pw_click', 'pw_type', 'pw_press', 'pw_upload_file', 'pw_wait_for']);

const LOCATOR_PROPS = {
  testid: { type: 'string', description: 'data-testid from the app map (preferred).' },
  role: { type: 'string', description: 'ARIA role (button, link, textbox, ...).' },
  name: { type: 'string', description: 'Accessible name (used with role).' },
  selector: { type: 'string', description: 'CSS selector — last resort.' },
};

const PW_TOOLS = [
  {
    name: 'pw_navigate',
    description:
      'Navigate to a URL. Relative paths (/app/...) resolve against the app origin. Cross-origin is blocked.',
    input_schema: {
      type: 'object',
      properties: { url: { type: 'string' } },
      required: ['url'],
    },
  },
  {
    name: 'pw_click',
    description: 'Click an element. Prefer testid from the app map, else role+name, else a CSS selector.',
    input_schema: { type: 'object', properties: { ...LOCATOR_PROPS } },
  },
  {
    name: 'pw_type',
    description:
      'Type into an input. For credentials use the placeholder tokens from the task context ' +
      '(e.g. "{{USERNAME}}") — never a real value.',
    input_schema: {
      type: 'object',
      properties: {
        ...LOCATOR_PROPS,
        text: { type: 'string' },
        submit: { type: 'boolean', description: 'Press Enter after typing.' },
      },
      required: ['text'],
    },
  },
  {
    name: 'pw_press',
    description: 'Press a key (e.g. Enter, Escape) on the focused element.',
    input_schema: {
      type: 'object',
      properties: { key: { type: 'string' } },
      required: ['key'],
    },
  },
  {
    name: 'pw_snapshot',
    description: 'Compact accessibility snapshot of the current page. Use before deciding where to click.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'pw_get_text',
    description: 'Read visible text of an element (or the whole page) to verify an expectation.',
    input_schema: { type: 'object', properties: { ...LOCATOR_PROPS } },
  },
  {
    name: 'pw_wait_for',
    description:
      'Wait for an element or text to become visible/hidden. Use for async/streaming steps instead of guessing.',
    input_schema: {
      type: 'object',
      properties: {
        ...LOCATOR_PROPS,
        text: { type: 'string', description: 'Wait for this text to be visible on the page.' },
        state: { type: 'string', enum: ['visible', 'hidden'], description: 'Default: visible.' },
        timeoutMs: { type: 'integer', description: 'Max wait; defaults to the action timeout.' },
      },
    },
  },
  {
    name: 'pw_upload_file',
    description:
      'Set a harness fixture file on a file input. `file` is a bare filename from the fixtures directory (e.g. "sample.md").',
    input_schema: {
      type: 'object',
      properties: { ...LOCATOR_PROPS, file: { type: 'string' } },
      required: ['file'],
    },
  },
  VERDICT_TOOL,
];

// ── Credential placeholders ─────────────────────────────────────────────
const PLACEHOLDER_RX = /\{\{(USERNAME|PASSWORD|EMAIL|TOTP)\}\}/g;

function substitutePlaceholders(text, credentials) {
  if (typeof text !== 'string' || !credentials) return text;
  return text.replace(PLACEHOLDER_RX, (_, key) => {
    const v = credentials[key.toLowerCase()];
    return typeof v === 'string' && v.length > 0 ? v : `{{${key}}}`;
  });
}

function redactInputForLogs(input, credentials) {
  if (!input || typeof input !== 'object') return input;
  const out = { ...input };
  if (typeof out.text === 'string' && credentials) {
    let masked = out.text;
    for (const [k, v] of Object.entries(credentials)) {
      if (typeof v === 'string' && v.length > 2 && masked.includes(v)) {
        masked = masked.split(v).join(`{{${k.toUpperCase()}}}`);
      }
    }
    out.text = masked;
  }
  return out;
}

// ── Locators & tool execution ────────────────────────────────────────────

function resolveLocator(page, { testid, role, name, selector }) {
  if (testid) return page.getByTestId(testid);
  if (role && name) return page.getByRole(role, { name });
  if (role) return page.getByRole(role);
  if (selector) return page.locator(selector);
  throw new Error('locator requires testid, role(+name), or selector');
}

async function executeTool(page, name, input, ctx) {
  const { credentials, sameOriginGuard, baseUrl, actionTimeoutMs } = ctx;
  switch (name) {
    case 'pw_navigate': {
      const raw = String(input?.url || '').trim();
      if (!raw) return { ok: false, error: 'url is required' };
      const url = new URL(raw, baseUrl).toString();
      if (!sameOriginGuard(url)) return { ok: false, error: 'navigation_blocked: cross_origin' };
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      return { ok: true, url: page.url(), title: await page.title().catch(() => '') };
    }
    case 'pw_click': {
      const loc = resolveLocator(page, input || {});
      await loc.first().click({ timeout: actionTimeoutMs });
      return { ok: true };
    }
    case 'pw_type': {
      const rawText = String(input?.text ?? '');
      const text = substitutePlaceholders(rawText, credentials);
      const loc =
        input?.testid || input?.role || input?.selector
          ? resolveLocator(page, input)
          : page.locator('input:visible, textarea:visible, [contenteditable="true"]:visible').first();
      await loc.first().fill(text, { timeout: actionTimeoutMs });
      if (input?.submit) await loc.first().press('Enter');
      return { ok: true, typed: text.length, usedCredential: text !== rawText };
    }
    case 'pw_press': {
      const key = String(input?.key || '').trim();
      if (!key) return { ok: false, error: 'key is required' };
      await page.keyboard.press(key);
      return { ok: true };
    }
    case 'pw_snapshot': {
      let tree = '';
      try {
        tree = await page.locator('body').ariaSnapshot({ timeout: actionTimeoutMs });
      } catch {
        tree = '(aria snapshot unavailable)';
      }
      return { ok: true, url: page.url(), tree: String(tree).slice(0, SNAPSHOT_CAP) };
    }
    case 'pw_get_text': {
      const hasLocator = input?.testid || input?.role || input?.selector;
      const loc = hasLocator ? resolveLocator(page, input) : page.locator('body');
      const txt = await loc.first().innerText({ timeout: actionTimeoutMs }).catch(() => '');
      return { ok: true, text: String(txt).slice(0, TEXT_CAP) };
    }
    case 'pw_wait_for': {
      const state = input?.state === 'hidden' ? 'hidden' : 'visible';
      const timeout = Number.isFinite(input?.timeoutMs) ? input.timeoutMs : actionTimeoutMs;
      if (input?.text && !input?.testid && !input?.selector && !input?.role) {
        await page.getByText(input.text, { exact: false }).first().waitFor({ state, timeout });
      } else {
        await resolveLocator(page, input || {}).first().waitFor({ state, timeout });
      }
      return { ok: true, state };
    }
    case 'pw_upload_file': {
      const file = path.basename(String(input?.file || ''));
      const full = path.join(FIXTURES_DATA_DIR, file);
      if (!file || !fs.existsSync(full)) {
        return { ok: false, error: `unknown fixture file '${file}' — available: ${fs.readdirSync(FIXTURES_DATA_DIR).join(', ')}` };
      }
      const loc = input?.testid || input?.role || input?.selector
        ? resolveLocator(page, input)
        : page.locator('input[type="file"]').first();
      await loc.first().setInputFiles(full, { timeout: actionTimeoutMs });
      return { ok: true, file };
    }
    default:
      return { ok: false, error: `unknown_tool: ${name}` };
  }
}

/**
 * Capture the current page state after an action so the model sees the
 * consequence in the same turn — this halves the act→snapshot→act loop that
 * made the agent waste steps. Saves the screenshot to disk as evidence and,
 * when vision is on, returns it as base64 for a tool_result image block.
 */
async function captureObservation(page, { actionTimeoutMs, vision, shotPath }) {
  let snapshot = '';
  try {
    snapshot = String(await page.locator('body').ariaSnapshot({ timeout: actionTimeoutMs })).slice(0, SNAPSHOT_CAP);
  } catch {
    snapshot = '(aria snapshot unavailable)';
  }
  let shotB64 = null;
  try {
    const buf = await page.screenshot({ path: shotPath, timeout: 5000 });
    if (vision && buf) shotB64 = buf.toString('base64');
  } catch {
    /* page may have navigated mid-shot — evidence is best-effort */
  }
  return { url: page.url(), snapshot, shotB64 };
}

/** Build the tool_result content (text + optional page state + optional image). */
function buildToolResult(toolUseId, resultJson, observation, isError, vision) {
  let text = resultJson;
  if (observation?.snapshot) {
    text += `\n\n[current page: ${observation.url}]\nAccessibility snapshot:\n${observation.snapshot}`;
  }
  const content = [{ type: 'text', text }];
  // The Anthropic API requires an is_error tool_result to be text-only, so the
  // screenshot is only attached on success.
  if (vision && !isError && observation?.shotB64) {
    content.push({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: observation.shotB64 } });
  }
  return { type: 'tool_result', tool_use_id: toolUseId, content, ...(isError ? { is_error: true } : {}) };
}

function summarizeInput(input) {
  if (!input || typeof input !== 'object') return '';
  const parts = [];
  for (const k of ['url', 'testid', 'selector', 'key', 'file']) if (input[k]) parts.push(`${k}=${input[k]}`);
  if (input.role || input.name) parts.push(`${input.role || ''}:${input.name || ''}`);
  if (input.text) parts.push(`"${String(input.text).slice(0, 40)}"`);
  if (input.verdict) parts.push(`verdict=${input.verdict}`);
  return parts.join(' ').slice(0, 160);
}

/**
 * Is this thrown error an infrastructure fault (not a scenario failure)?
 * - browser never launched (missing Chromium binary, sandbox issue)
 * - Anthropic transport / 5xx / 429 (outage, rate limit) after SDK retries
 */
function isInfraError(e, launched) {
  if (!launched) return true;
  const status = e?.status ?? e?.response?.status;
  if (typeof status === 'number' && (status === 429 || status >= 500)) return true;
  const name = String(e?.name || '');
  if (/APIConnection|Connection|Timeout|ECONNRESET|ENOTFOUND|fetch failed/i.test(name)) return true;
  return /ECONNRESET|ENOTFOUND|ETIMEDOUT|fetch failed|socket hang up/i.test(String(e?.message || ''));
}

// ── Main run ─────────────────────────────────────────────────────────────

/**
 * Execute one scenario agentically.
 * @returns {Promise<{verdict: object, artifactsDir: string}>}
 */
export async function runAgenticScenario(scenario, { headed = false } = {}) {
  loadDotEnv();
  const cfg = loadConfig();
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw Object.assign(new Error('ANTHROPIC_API_KEY is required for agentic runs'), { infra: true });

  const baseUrl = process.env.BASE_URL || 'http://localhost:5176';
  const model = cfg.models?.agentic || 'claude-sonnet-5';
  const maxSteps = cfg.agentic?.maxSteps ?? 40;
  const actionTimeoutMs = cfg.agentic?.actionTimeoutMs ?? 15_000;
  // Vision (screenshot per action) is on by default; disable via
  // e2e.config.json "agentic": { "vision": false } or E2E_VISION=0.
  const vision = process.env.E2E_VISION
    ? !['0', 'false', 'off'].includes(process.env.E2E_VISION.toLowerCase())
    : cfg.agentic?.vision !== false;
  const wallDeadline = Date.now() + Math.max(scenario.timeout * 3, 300_000);

  const credentials = {};
  if (process.env.ADMIN_USER) credentials.username = process.env.ADMIN_USER;
  if (process.env.ADMIN_PASSWORD) credentials.password = process.env.ADMIN_PASSWORD;

  const outDir = ensureDir(path.join(ARTIFACTS_DIR, 'agentic', scenario.id));
  const actions = [];
  const runId = `e2e-${Date.now().toString(36)}`;
  const targetOrigin = new URL(baseUrl).origin;
  const sameOriginGuard = (rawUrl) => {
    try {
      return new URL(rawUrl, baseUrl).origin === targetOrigin;
    } catch {
      return false;
    }
  };

  const systemPrompt =
    fs.readFileSync(PROMPT_FILE, 'utf8') +
    (fs.existsSync(APP_MAP_FILE) ? `\n\n---\n\n${fs.readFileSync(APP_MAP_FILE, 'utf8')}` : '');

  const placeholders = Object.keys(credentials).map((k) => `{{${k.toUpperCase()}}}`);
  const authNote =
    scenario.auth === 'admin'
      ? 'You start LOGGED OUT: first log in via the Login section of the app map using the placeholder tokens, then execute the steps.'
      : 'Run the scenario from the logged-out state it starts in.';
  const seed = `Execute this smoke scenario against the app at ${baseUrl} (origin ${targetOrigin}).

runId for this run (embed in every entity name you create): ${runId}

${placeholders.length ? `Credential placeholders available: ${placeholders.join(', ')}. ${authNote}` : authNote}

── Scenario: ${scenario.id} — ${scenario.title} ──
${scenario.body.trim()}

${scenario.cleanup ? `── Cleanup duty (always execute before report_verdict) ──\n${scenario.cleanup}\n` : ''}
The browser is already open on ${baseUrl}. The current page state is shown below; after every action you take, the updated state (accessibility snapshot${vision ? ' and a screenshot' : ''}) is returned automatically, so you rarely need pw_snapshot. Work through the steps, then end with report_verdict.`;

  const client = new Anthropic({ apiKey, timeout: 600_000 });
  let browser;
  let launched = false;
  let verdict = null;
  let turns = 0;
  let shots = 0;
  const startedAt = new Date().toISOString();

  try {
    browser = await chromium.launch({ headless: !headed });
    launched = true;
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await context.route('**/*', (route, req) => {
      if (req.isNavigationRequest() && !sameOriginGuard(req.url())) return route.abort();
      return route.continue();
    });
    const page = await context.newPage();
    page.setDefaultTimeout(actionTimeoutMs);
    await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });

    // Ground the model in the initial page state before its first action.
    const seedObs = await captureObservation(page, {
      actionTimeoutMs,
      vision,
      shotPath: path.join(outDir, 'step-00-initial.png'),
    });
    const seedContent = [{ type: 'text', text: `${seed}\n\n[current page: ${seedObs.url}]\nAccessibility snapshot:\n${seedObs.snapshot}` }];
    if (vision && seedObs.shotB64) {
      seedContent.push({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: seedObs.shotB64 } });
    }
    const messages = [{ role: 'user', content: seedContent }];

    while (turns < maxSteps && !verdict && Date.now() < wallDeadline) {
      turns += 1;
      const resp = await client.messages.create({
        model,
        max_tokens: 4096,
        system: systemPrompt,
        messages,
        tools: PW_TOOLS,
      });
      messages.push({ role: 'assistant', content: resp.content });

      const toolUses = resp.content.filter((b) => b.type === 'tool_use');
      if (toolUses.length === 0) {
        // Text-only turn: nudge once, then give up (synthesized failure below).
        if (resp.stop_reason === 'end_turn') {
          messages.push({
            role: 'user',
            content:
              'You must act via tools. Continue the scenario with a pw_* call, or finish with report_verdict.',
          });
          continue;
        }
        break;
      }

      const results = [];
      for (const tu of toolUses) {
        const safeInput = redactInputForLogs(tu.input, credentials);
        actions.push({ turn: turns, tool: tu.name, input: safeInput });
        console.log(`[agentic:${scenario.id}] ${tu.name} ${summarizeInput(safeInput)}`);

        if (tu.name === 'report_verdict') {
          const check = validateVerdict(tu.input);
          if (!check.ok) {
            results.push({
              type: 'tool_result',
              tool_use_id: tu.id,
              content: JSON.stringify({ ok: false, error: `invalid verdict: ${check.errors.join('; ')}` }),
              is_error: true,
            });
            continue;
          }
          verdict = tu.input;
          results.push({ type: 'tool_result', tool_use_id: tu.id, content: JSON.stringify({ ok: true }) });
          continue;
        }

        let result;
        try {
          result = await executeTool(page, tu.name, tu.input || {}, {
            credentials,
            sameOriginGuard,
            baseUrl,
            actionTimeoutMs,
          });
        } catch (e) {
          result = { ok: false, error: String(e && e.message ? e.message : e).slice(0, 500) };
        }

        // Observe the resulting page state (evidence screenshot always; snapshot
        // appended for state-changing tools; image attached when vision is on).
        shots += 1;
        const shotFile = path.join(outDir, `step-${String(shots).padStart(2, '0')}-${tu.name}.png`);
        const observation = await captureObservation(page, { actionTimeoutMs, vision, shotPath: shotFile });
        if (!OBSERVE_AFTER.has(tu.name)) observation.snapshot = ''; // read-only tools already returned their data

        results.push(
          buildToolResult(tu.id, JSON.stringify(result).slice(0, TOOL_RESULT_CAP), observation, result.ok === false, vision),
        );
      }
      messages.push({ role: 'user', content: results });
    }
  } catch (e) {
    // Distinguish infrastructure failures from scenario failures: a browser
    // that never launched, or an Anthropic transport/5xx/429 error, is not a
    // regression in the app under test. Re-throw those as infra so the
    // orchestrator returns exit 3 instead of labelling a real outage a
    // "regression-confirmed" and sending developers chasing a phantom bug.
    if (isInfraError(e, launched)) {
      await browser?.close().catch(() => {});
      throw Object.assign(new Error(`agentic infra error (${scenario.id}): ${String(e?.message || e).slice(0, 300)}`), {
        infra: true,
      });
    }
    verdict = verdict || synthesizedFailure(`runner error: ${String(e && e.message ? e.message : e).slice(0, 300)}`);
  } finally {
    await browser?.close().catch(() => {});
  }

  if (!verdict) {
    verdict =
      Date.now() >= wallDeadline
        ? synthesizedFailure(`wall-clock budget exceeded after ${turns} turns`)
        : synthesizedFailure(`step cap (${maxSteps}) reached without report_verdict`);
  }

  const record = {
    scenarioId: scenario.id,
    mode: 'agentic',
    verdict: verdict.verdict,
    summary: verdict.summary,
    steps: verdict.steps,
    failed_step: verdict.failed_step,
    reasoning: verdict.reasoning,
    synthesized: Boolean(verdict.synthesized),
    model,
    vision,
    turns,
    runId,
    startedAt,
    endedAt: new Date().toISOString(),
    evidence: fs.readdirSync(outDir).filter((f) => f.endsWith('.png')),
  };
  fs.writeFileSync(path.join(outDir, 'verdict.json'), JSON.stringify(record, null, 2));
  fs.writeFileSync(path.join(outDir, 'transcript.json'), JSON.stringify({ actions }, null, 2));
  return { verdict: record, artifactsDir: outDir };
}

// ── CLI ──────────────────────────────────────────────────────────────────

async function cli() {
  loadDotEnv();
  const args = process.argv.slice(2);
  const headed = args.includes('--headed');
  const id = args.find((a) => !a.startsWith('-'));
  if (!id) {
    console.error('usage: npm run agentic -- <scenario-id> [--headed]');
    process.exit(3);
  }
  const scenario = loadScenarios().find((s) => s.id === id);
  if (!scenario) {
    console.error(`[agentic] unknown scenario '${id}'`);
    process.exit(3);
  }
  try {
    const { verdict, artifactsDir } = await runAgenticScenario(scenario, { headed });
    console.log(`\n[agentic] ${id}: ${verdict.verdict.toUpperCase()} — ${verdict.summary}`);
    console.log(`[agentic] evidence: ${artifactsDir}`);
    process.exit(verdict.verdict === 'pass' ? 0 : 1);
  } catch (e) {
    console.error(`[agentic] ${e.message || e}`);
    process.exit(e.infra ? 3 : 1);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  cli();
}
