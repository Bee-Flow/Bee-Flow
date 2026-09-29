/**
 * releaseNotesFormat — unit tests.
 *
 * Run: node --test core/releaseNotesFormat.test.js
 *
 * This module is the contract between two drafters that never run in the same
 * process — the server (llmClient) and CI (Anthropic SDK). The tests that matter
 * most here are the ones that would catch the two halves drifting apart: the
 * schema and the prompt describing the same shape, and the renderer refusing to
 * emit an empty scaffold.
 *
 * No requires beyond node builtins — the module must stay loadable from a bare
 * checkout with no server node_modules.
 */

const { test } = require('node:test');
const assert = require('node:assert');

const fmt = require('./releaseNotesFormat');

// ── The module's own constraint ────────────────────────────────────────

test('the module has no dependencies — CI loads it without server node_modules', () => {
    const fs = require('node:fs');
    const src = fs.readFileSync(require.resolve('./releaseNotesFormat'), 'utf8')
        // Comments first: the file's own header says "never add a require()".
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '');
    const requires = src.match(/\brequire\s*\(/g) || [];
    assert.strictEqual(requires.length, 0, 'releaseNotesFormat must not require anything');
});

// ── Schema ↔ prompt agreement ──────────────────────────────────────────

test('the JSON schema and the prompt describe the same three kinds', () => {
    const kinds = fmt.NOTES_SCHEMA.properties.items.items.properties.kind.enum;
    assert.deepStrictEqual(kinds, ['feature', 'improvement', 'fix']);
    for (const kind of kinds) {
        assert.ok(fmt.SYSTEM_PROMPT.includes(`"${kind}`), `prompt should mention ${kind}`);
        assert.ok(fmt.KIND_HEADINGS[kind], `${kind} needs a customer-facing heading`);
    }
});

test('the schema pins every field the store reads', () => {
    assert.deepStrictEqual(fmt.NOTES_SCHEMA.required, ['title', 'lead', 'items']);
    assert.deepStrictEqual(
        fmt.NOTES_SCHEMA.properties.items.items.required,
        ['kind', 'title', 'body'],
    );
    // Without this the model may invent fields that reach the changelog.
    assert.strictEqual(fmt.NOTES_SCHEMA.additionalProperties, false);
    assert.strictEqual(fmt.NOTES_SCHEMA.properties.items.items.additionalProperties, false);
});

test('the prompt still forbids internal identifiers reaching customers', () => {
    assert.match(fmt.SYSTEM_PROMPT, /BFSF-123/);
    assert.match(fmt.SYSTEM_PROMPT, /Never invent/i);
});

// ── buildUserPayload ───────────────────────────────────────────────────

test('buildUserPayload leads with PR titles — they carry the signal', () => {
    const out = fmt.buildUserPayload({
        prTitles: ['Merge pull request #1 from x'],
        commitSubjects: ['feat: y'],
    });
    assert.ok(out.indexOf('Pull request titles:') < out.indexOf('Commit subjects:'));
});

test('buildUserPayload truncates the diffstat rather than sending it whole', () => {
    const out = fmt.buildUserPayload({
        commitSubjects: ['feat: x'],
        diffstat: 'x'.repeat(9000),
    });
    assert.ok(out.length < 6000, 'a runaway diffstat must not reach the model');
});

test('buildUserPayload says "unreleased" when there is no version', () => {
    assert.match(fmt.buildUserPayload({ commitSubjects: ['a'] }), /Version: unreleased/);
});

// ── renderMarkdown ─────────────────────────────────────────────────────

test('renderMarkdown groups items under customer-facing headings', () => {
    const md = fmt.renderMarkdown({
        title: 'August release',
        lead: 'Faster search and two fixes.',
        items: [
            { kind: 'fix', title: 'Chat keeps answers', body: 'Navigating away no longer drops a reply.' },
            { kind: 'feature', title: 'Release notes', body: 'The changelog is now in the app.' },
        ],
    });

    assert.match(md, /^## August release/);
    assert.match(md, /Faster search and two fixes\./);
    // Features first, fixes last — the order a reader expects.
    assert.ok(md.indexOf('### New') < md.indexOf('### Fixed'));
    assert.match(md, /- \*\*Release notes\*\* — The changelog is now in the app\./);
    assert.ok(!md.includes('### Improved'), 'an empty group must not get a heading');
});

test('renderMarkdown returns EMPTY for an empty draft, not a bare heading', () => {
    // The Release body falls back to GitHub's generated commit list on '' —
    // an empty "What's new" section would be worse than no section.
    assert.strictEqual(fmt.renderMarkdown({ title: '', lead: '', items: [] }), '');
    assert.strictEqual(fmt.renderMarkdown({}), '');
    assert.strictEqual(fmt.renderMarkdown(), '');
});

test('renderMarkdown copes with an item that has a title and no body', () => {
    const md = fmt.renderMarkdown({ items: [{ kind: 'fix', title: 'A thing' }] });
    assert.match(md, /- \*\*A thing\*\*$/m);
    assert.ok(!md.includes('—'), 'no dangling em dash when there is no body');
});

test('renderMarkdown runs the draft through coercion first', () => {
    // Reaches the renderer straight off the wire at /ingest, so an unknown kind
    // must land somewhere rather than vanish.
    const md = fmt.renderMarkdown({ items: [{ kind: 'enhancement', title: 'X', body: 'Y' }] });
    assert.match(md, /### Improved/);
});

// ── coerceDraft — the wire-facing guard ────────────────────────────────

test('coerceDraft bounds what a token holder can write into the changelog', () => {
    const out = fmt.coerceDraft({
        title: 'T'.repeat(500),
        lead: '  spaced  ',
        items: Array.from({ length: 60 }, (_, i) => ({ kind: 'fix', title: `t${i}`, body: 'b' })),
    });
    assert.strictEqual(out.title.length, fmt.MAX_TITLE_LEN);
    assert.strictEqual(out.lead, 'spaced');
    assert.strictEqual(out.items.length, fmt.MAX_ITEMS);
});

test('coerceDraft survives garbage without throwing', () => {
    for (const junk of [null, undefined, 'a string', 42, { items: 'not an array' }, { items: [null, 7] }]) {
        const out = fmt.coerceDraft(junk);
        assert.deepStrictEqual(out, { title: '', lead: '', items: [] });
    }
});
