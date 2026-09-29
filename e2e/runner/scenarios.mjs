/**
 * Shared plumbing for the e2e runner scripts: scenario loading + validation,
 * the scenario content hash that ties committed generated specs to their
 * source scenario, config loading with env overrides, and small helpers.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import matter from 'gray-matter';

export const E2E_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const SCENARIO_DIR = path.join(E2E_ROOT, 'scenarios');
export const GENERATED_DIR = path.join(E2E_ROOT, 'tests', 'generated');
export const ARTIFACTS_DIR = path.join(E2E_ROOT, 'artifacts');
export const FIXTURES_DATA_DIR = path.join(E2E_ROOT, 'fixtures-data');

// Bump when the generator prompt/contract changes in a way that should force
// regeneration of every committed spec (the hash embeds this version).
export const PROMPT_VERSION = 1;

export const MODES = ['generated', 'agentic', 'generated+agentic-fallback'];
const AUTHS = ['admin', 'none'];
export const KNOWN_CAPABILITIES = ['llm', 'search', 'search-retrieval'];

/** Load e2e/.env for local runs; real environment variables always win. */
export function loadDotEnv() {
  const envFile = path.join(E2E_ROOT, '.env');
  if (!fs.existsSync(envFile)) return;
  for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m && !(m[1] in process.env)) {
      process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
    }
  }
}

/**
 * Content hash binding a generated spec to its scenario file. LF-normalized
 * so Windows/Linux checkouts agree; salted with PROMPT_VERSION so a contract
 * change invalidates every spec at once.
 */
export function scenarioHash(rawFileContent) {
  const normalized = String(rawFileContent).replace(/\r\n/g, '\n');
  return crypto.createHash('sha256').update(`v${PROMPT_VERSION}\n${normalized}`).digest('hex');
}

function fail(file, msg) {
  throw new Error(`[scenarios] ${path.basename(file)}: ${msg}`);
}

function parseScenarioFile(file) {
  const raw = fs.readFileSync(file, 'utf8');
  const { data: fm, content: body } = matter(raw);
  const id = path.basename(file, '.md');

  if (!fm || typeof fm !== 'object') fail(file, 'missing YAML frontmatter');
  if (fm.id !== id) fail(file, `frontmatter id '${fm.id}' must equal filename '${id}'`);
  if (!fm.title || typeof fm.title !== 'string') fail(file, 'title is required');

  const mode = fm.mode ?? 'generated+agentic-fallback';
  if (!MODES.includes(mode)) fail(file, `mode '${mode}' must be one of: ${MODES.join(', ')}`);

  const auth = fm.auth ?? 'admin';
  if (!AUTHS.includes(auth)) fail(file, `auth '${auth}' must be one of: ${AUTHS.join(', ')}`);

  const requires = fm.requires ?? [];
  if (!Array.isArray(requires) || requires.some((r) => typeof r !== 'string')) {
    fail(file, 'requires must be an array of strings');
  }
  for (const r of requires) {
    if (!KNOWN_CAPABILITIES.includes(r)) {
      fail(file, `unknown capability '${r}' (known: ${KNOWN_CAPABILITIES.join(', ')})`);
    }
  }

  const timeout = fm.timeout ?? 90_000;
  if (!Number.isFinite(timeout) || timeout < 1000) fail(file, `timeout '${fm.timeout}' must be a number of ms >= 1000`);

  const tags = fm.tags ?? [];
  if (!Array.isArray(tags)) fail(file, 'tags must be an array');

  return {
    id,
    title: fm.title,
    mode,
    tags: tags.map(String),
    requires,
    timeout,
    auth,
    cleanup: typeof fm.cleanup === 'string' ? fm.cleanup : '',
    body,
    raw,
    file,
    hash: scenarioHash(raw),
  };
}

/** All scenarios (files not starting with '_'), validated, sorted by id. */
export function loadScenarios() {
  if (!fs.existsSync(SCENARIO_DIR)) return [];
  return fs
    .readdirSync(SCENARIO_DIR)
    .filter((f) => f.endsWith('.md') && !f.startsWith('_'))
    .sort()
    .map((f) => parseScenarioFile(path.join(SCENARIO_DIR, f)));
}

export function loadConfig() {
  const cfg = JSON.parse(fs.readFileSync(path.join(E2E_ROOT, 'e2e.config.json'), 'utf8'));
  if (process.env.E2E_MODE) {
    if (!MODES.includes(process.env.E2E_MODE)) {
      throw new Error(`[config] E2E_MODE '${process.env.E2E_MODE}' must be one of: ${MODES.join(', ')}`);
    }
    cfg.modeOverride = process.env.E2E_MODE;
  }
  if (process.env.E2E_FALLBACK !== undefined) {
    cfg.fallback = cfg.fallback || {};
    cfg.fallback.enabled = !['0', 'false', 'off'].includes(process.env.E2E_FALLBACK.toLowerCase());
  }
  return cfg;
}

/** Mode after applying the global override. */
export function effectiveMode(scenario, config) {
  return config?.modeOverride || scenario.mode;
}

/**
 * Capabilities offered by the target stack. Unset E2E_CAPABILITIES means
 * "assume everything is available" (local convenience); an empty string
 * means "nothing beyond the bare app".
 */
export function stackCapabilities() {
  const raw = process.env.E2E_CAPABILITIES;
  if (raw === undefined) return null; // unrestricted
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

export function isSupported(scenario, capabilities) {
  if (capabilities === null) return true;
  return scenario.requires.every((r) => capabilities.includes(r));
}

export function specPathFor(id) {
  return path.join(GENERATED_DIR, `${id}.spec.ts`);
}

/** Extract the embedded scenario-hash from a generated spec, or null. */
export function specHashOf(specContent) {
  const m = String(specContent).match(/scenario-hash:\s*sha256:([0-9a-f]{64})/);
  return m ? m[1] : null;
}

export function readJsonSafe(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
