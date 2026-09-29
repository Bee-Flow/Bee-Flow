/**
 * Static sanity checks on a generated Playwright spec.
 *
 * Deliberately dependency-free (NO imports at all) so it can be unit-tested
 * with `node --test` in a checkout that has no e2e/node_modules — the module
 * it used to live in (runner/gen.mjs) pulls in @anthropic-ai/sdk and, through
 * scenarios.mjs, gray-matter, which made the linter untestable in CI-less
 * environments. gen.mjs imports and re-exports it, so `import { lintSpec }
 * from './gen.mjs'` keeps working.
 */

/**
 * Method names whose argument list carries text that is matched against the
 * PAGE. The whole balanced argument list is scanned, not just a first string
 * argument, because half of these carry the text in an options object:
 * `getByRole('cell', { name: /…/ })`, `.filter({ hasText: … })`.
 *
 * `getByRole` in particular is not optional. prompts/spec-generator.md tells
 * the model, in as many words, to "fall back to getByRole with accessible
 * names quoted in the app_map" when no testid fits — so leaving it out made
 * the rule blind to precisely the shape the generator is instructed to
 * produce, on the very spec (kb-upload) the rule was written for.
 */
const TEXT_MATCHERS = [
  'getByText',
  'toHaveText',
  'toContainText',
  'getByTitle',
  'getByLabel',
  'getByPlaceholder',
  'locator',
  // Text carried in an options object rather than as a bare string.
  'getByRole',
  'filter', // .filter({ hasText }) / ({ hasNotText }) — both are page text
  'getByAltText',
  'toHaveAccessibleName',
  // The raw-selector escape hatch: waitForSelector('text=3 chunks').
  'waitForSelector',
];

const CHUNK_WORD = /\bchunks?\b/i;

const CHUNK_PROBLEM =
  'waits on chunk text — "N chunks" no longer exists anywhere in Studio ' +
  '(agent-hub/src/.../KnowledgeStudio/SourcesTab.jsx removed it on purpose), so the wait ' +
  'hangs until the timeout. Wait for a `kb-doc-row` whose data-status is "processed" or ' +
  '"redacted" instead. (Comments are exempt from this rule: only real matcher calls count, ' +
  'so a commented-out line or a note mentioning chunks is fine.)';

/**
 * Blank out comment bodies (keeping length and newlines) so the checks below
 * only look at executable code. String/template literals are tracked so an
 * apostrophe or a `//` inside a quoted string cannot start a fake comment;
 * a `/` escaped with a backslash (regex literals like /a\/b/) is skipped.
 */
export function maskComments(code) {
  const src = String(code);
  const out = src.split('');
  let state = 'code'; // code | line | block | "'" | '"' | '`'
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    const next = src[i + 1];
    const prev = i > 0 ? src[i - 1] : '';
    if (state === 'line') {
      if (c === '\n') state = 'code';
      else out[i] = ' ';
      continue;
    }
    if (state === 'block') {
      if (c === '*' && next === '/') {
        out[i] = ' ';
        out[i + 1] = ' ';
        i++;
      } else if (c !== '\n') {
        out[i] = ' ';
      }
      continue;
    }
    if (state === "'" || state === '"' || state === '`') {
      if (c === '\\') i++; // skip the escaped char
      else if (c === state) state = 'code';
      continue;
    }
    // state === 'code'
    if (c === "'" || c === '"' || c === '`') {
      state = c;
    } else if (c === '/' && prev !== '\\' && (next === '/' || next === '*')) {
      state = next === '/' ? 'line' : 'block';
      out[i] = ' ';
      out[i + 1] = ' ';
      i++;
    }
  }
  return out.join('');
}

/**
 * Every argument list passed to `name(...)`, with balanced parentheses so a
 * regex or object literal containing `(` `)` is still captured whole.
 */
export function callArguments(code, name) {
  const src = String(code);
  const args = [];
  const re = new RegExp(`\\b${name}\\s*\\(`, 'g');
  let m;
  while ((m = re.exec(src)) !== null) {
    let depth = 1;
    let i = m.index + m[0].length;
    const start = i;
    for (; i < src.length && depth > 0; i++) {
      if (src[i] === '(') depth++;
      else if (src[i] === ')') depth--;
    }
    if (depth === 0) args.push(src.slice(start, i - 1));
  }
  return args;
}

/** Static sanity checks on the generated spec. Returns a list of violations. */
export function lintSpec(code, scenario, appMap) {
  const problems = [];
  if (!/import\s*\{[^}]*\btest\b[^}]*\}\s*from\s*'\.\.\/fixtures'/.test(code)) {
    problems.push("must import { test, expect } from '../fixtures'");
  }
  if (/waitForTimeout/.test(code)) {
    problems.push('page.waitForTimeout is forbidden — use web-first assertions or waitFor');
  }
  if (scenario.auth === 'admin' && !/storageState:\s*AUTH_FILE/.test(code)) {
    problems.push("auth: admin requires test.use({ storageState: AUTH_FILE })");
  }
  if (scenario.auth === 'none' && /storageState/.test(code)) {
    problems.push('auth: none must not use storageState — log in through the UI');
  }
  const pwd = process.env.ADMIN_PASSWORD;
  if (pwd && pwd.length > 3 && code.includes(pwd)) {
    problems.push('spec contains a literal credential value');
  }
  // Every literal getByTestId('...') must exist in the app map. Template
  // literals (dynamic ids) are exempt — the map documents their patterns.
  for (const m of code.matchAll(/getByTestId\(\s*'([^']+)'\s*\)/g)) {
    if (!appMap.includes(m[1])) {
      problems.push(`getByTestId('${m[1]}') does not appear in context/app-map.md`);
    }
  }
  // Chunk counts are gone from Studio; a spec that waits for them hangs.
  const executable = maskComments(code);
  if (TEXT_MATCHERS.some((name) => callArguments(executable, name).some((a) => CHUNK_WORD.test(a)))) {
    problems.push(CHUNK_PROBLEM);
  }
  return problems;
}
