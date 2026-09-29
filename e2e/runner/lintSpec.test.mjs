/**
 * Unit tests for the generated-spec linter.
 *
 * Dependency-free on purpose: `node --test runner/lintSpec.test.mjs` must pass
 * in a checkout without e2e/node_modules (playwright, gray-matter and the
 * Anthropic SDK are not installed in every environment that reviews specs).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { lintSpec, maskComments, callArguments } from './lintSpec.mjs';

const APP_MAP = [
  '- **Detail** (testid `kb-detail-page`, `data-kb-id`)',
  '- **Sources tab** (testid `kb-tab-sources`): rows testid `kb-source-row`',
  '- **Source detail** (testid `kb-source-detail`): rows testid `kb-doc-row`',
  '- **Create**: button testid `kb-create`',
].join('\n');

const ADMIN = { id: 'kb-upload', auth: 'admin' };
const ANON = { id: 'login', auth: 'none' };

/** A minimal spec that must lint clean. */
const CLEAN = `import { test, expect, AUTH_FILE } from '../fixtures';

test.use({ storageState: AUTH_FILE });

test('kb', async ({ page }) => {
  await page.goto('/app/studio/knowledge');
  await page.getByTestId('kb-create').click();
  const detail = page.getByTestId('kb-detail-page');
  await expect(detail).toBeVisible();
  const row = page.getByTestId('kb-source-detail').getByTestId('kb-doc-row').first();
  await expect(row).toHaveAttribute('data-status', /^(processed|redacted)$/, { timeout: 90_000 });
});
`;

/** The exact line that ships in tests/generated/kb-upload.spec.ts today. */
const REAL_CHUNK_LINE =
  "  await expect(detail.getByText(/[1-9]\\d* chunks/).first()).toBeVisible({ timeout: 90_000 });";

const hasChunkProblem = (problems) => problems.some((p) => /chunk/i.test(p));

test('a clean spec produces no problems', () => {
  assert.deepEqual(lintSpec(CLEAN, ADMIN, APP_MAP), []);
});

test('rule 1: the fixtures import is mandatory', () => {
  const code = CLEAN.replace("from '../fixtures'", "from '@playwright/test'");
  const problems = lintSpec(code, ADMIN, APP_MAP);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /must import \{ test, expect \} from '\.\.\/fixtures'/);
});

test('rule 2: waitForTimeout is forbidden', () => {
  const code = CLEAN.replace('await expect(detail).toBeVisible();', 'await page.waitForTimeout(3000);');
  assert.ok(lintSpec(code, ADMIN, APP_MAP).some((p) => /waitForTimeout is forbidden/.test(p)));
});

test('rule 3: auth admin requires storageState: AUTH_FILE', () => {
  const code = CLEAN.replace('test.use({ storageState: AUTH_FILE });', '');
  assert.ok(lintSpec(code, ADMIN, APP_MAP).some((p) => /auth: admin requires/.test(p)));
  // ...and the same code is fine for a scenario that does not need auth.
  assert.deepEqual(lintSpec(code, ANON, APP_MAP), []);
});

test('rule 4: auth none must not use storageState', () => {
  assert.ok(lintSpec(CLEAN, ANON, APP_MAP).some((p) => /auth: none must not use storageState/.test(p)));
});

test('rule 5: a literal credential value is rejected', () => {
  const previous = process.env.ADMIN_PASSWORD;
  process.env.ADMIN_PASSWORD = 'sup3r-secret-value';
  try {
    const code = CLEAN.replace("'/app/studio/knowledge'", "'/app?p=sup3r-secret-value'");
    assert.ok(lintSpec(code, ADMIN, APP_MAP).some((p) => /literal credential value/.test(p)));
    // A short/absent password must not turn every spec into a violation.
    process.env.ADMIN_PASSWORD = 'ab';
    assert.deepEqual(lintSpec(CLEAN, ADMIN, APP_MAP), []);
  } finally {
    if (previous === undefined) delete process.env.ADMIN_PASSWORD;
    else process.env.ADMIN_PASSWORD = previous;
  }
});

test('rule 6: an unknown getByTestId is rejected, a documented one is not', () => {
  const code = CLEAN.replace("getByTestId('kb-create')", "getByTestId('kb-create-btn-typo')");
  const problems = lintSpec(code, ADMIN, APP_MAP);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /getByTestId\('kb-create-btn-typo'\) does not appear in context\/app-map\.md/);
});

test('rule 7: the real hanging chunk line from kb-upload.spec.ts is rejected', () => {
  const code = CLEAN.replace('  await expect(detail).toBeVisible();', REAL_CHUNK_LINE);
  const problems = lintSpec(code, ADMIN, APP_MAP);
  assert.ok(hasChunkProblem(problems), `expected a chunk problem, got: ${JSON.stringify(problems)}`);
  // The message must tell the builder what to wait for instead.
  const msg = problems.find((p) => /chunk/i.test(p));
  assert.match(msg, /kb-doc-row/);
  assert.match(msg, /processed/);
  assert.match(msg, /redacted/);
});

test('rule 7: other shapes of a chunk wait are rejected too', () => {
  const shapes = [
    "await expect(detail.getByText('12 chunks')).toBeVisible();",
    'await expect(row).toHaveText(/\\d+ chunks/);',
    'await expect(row).toContainText("chunk");',
    "await detail.locator('text=3 chunks').waitFor();",
    'await expect(detail.getByText(/(\\d+) chunks indexed/)).toBeVisible();',
  ];
  for (const shape of shapes) {
    const code = CLEAN.replace('  await expect(detail).toBeVisible();', `  ${shape}`);
    assert.ok(hasChunkProblem(lintSpec(code, ADMIN, APP_MAP)), `not caught: ${shape}`);
  }
});

test('rule 7: a chunk wait hidden in an OPTIONS OBJECT is rejected', () => {
  // The regression this covers: TEXT_MATCHERS used to hold only the seven
  // methods that take the text as a bare first argument, so every shape that
  // carries it in an options object walked straight through the linter —
  // including `getByRole`, which prompts/spec-generator.md explicitly tells
  // the generator to fall back to when no testid fits. lintSpec reported zero
  // problems and the smoke run hung to the timeout, which is the exact
  // failure rule 7 exists to prevent.
  const shapes = [
    "await expect(page.getByRole('cell', { name: /\\d+ chunks/ })).toBeVisible();",
    "await expect(page.getByRole('button', { name: '5 chunks' })).toBeVisible();",
    "await page.getByTestId('kb-doc-row').filter({ hasText: /chunks/ }).click();",
    "await page.getByTestId('kb-doc-row').filter({ hasNotText: '0 chunks' }).click();",
    "await page.waitForSelector('text=3 chunks');",
    "await expect(page.getByAltText('2 chunks')).toBeVisible();",
    'await expect(row).toHaveAccessibleName(/chunks/);',
  ];
  for (const shape of shapes) {
    const code = CLEAN.replace('  await expect(detail).toBeVisible();', `  ${shape}`);
    assert.ok(hasChunkProblem(lintSpec(code, ADMIN, APP_MAP)), `not caught: ${shape}`);
  }
});

test('rule 7: the added matchers do not fire on chunk-free code', () => {
  // The widened list must not turn every getByRole/filter into a violation:
  // these are the shapes real specs use, and they have to stay clean.
  const shapes = [
    "await page.getByRole('button', { name: 'Delete for good' }).click();",
    "await page.getByRole('textbox', { name: 'Choose files' }).setInputFiles('x.md');",
    "await page.getByTestId('kb-source-row').filter({ hasText: 'sample.md' }).click();",
    "await page.waitForSelector('[data-status=\"processed\"]');",
    "await expect(page.getByAltText('Bee Flow logo')).toBeVisible();",
  ];
  for (const shape of shapes) {
    const code = CLEAN.replace('  await expect(detail).toBeVisible();', `  ${shape}`);
    assert.deepEqual(lintSpec(code, ADMIN, APP_MAP), [], `false alarm on: ${shape}`);
  }
});

test('rule 7: the word chunk in a comment is NOT an alarm', () => {
  const code = CLEAN.replace(
    '  await expect(detail).toBeVisible();',
    [
      '  // Never wait for a chunk count — chunks are gone from Studio.',
      '  /* the old spec did: getByText(/[1-9]\\d* chunks/) */',
      "  const note = 'chunks are fine inside plain data';",
      '  await expect(detail).toBeVisible();',
    ].join('\n'),
  );
  assert.deepEqual(lintSpec(code, ADMIN, APP_MAP), []);
});

test('maskComments keeps code, blanks comments, and survives quotes and regexes', () => {
  const masked = maskComments("const a = '// not a comment'; // real\nconst b = /a\\/\\/b/;\n");
  assert.match(masked, /const a = '\/\/ not a comment';/);
  assert.doesNotMatch(masked, /real/);
  assert.match(masked, /const b = /);
});

test('callArguments captures balanced parentheses', () => {
  assert.deepEqual(callArguments("getByText(/(\\d+) chunks/)", 'getByText'), ['/(\\d+) chunks/']);
  assert.deepEqual(callArguments('nothing here', 'getByText'), []);
});
