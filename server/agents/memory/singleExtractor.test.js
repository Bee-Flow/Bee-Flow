// @typecheck strict
/**
 * There is exactly ONE memory extractor, and direct chat runs it once.
 *
 * There used to be two. `routes/ai/directChat.js` fired `core/memoryExtractor`
 * and `agents/memory/extractor` on the same turn: two fast-tier LLM calls per
 * message, and two concurrent unawaited dedupe-then-insert pipelines against
 * the same rows. `idx_memories_dedupe` is a plain index, not UNIQUE, so both
 * could pass `findSimilarMemory` and both insert.
 *
 * They also disagreed about the project gate — one passed
 * `extractMemoriesEnabled ? validProjectId : null`, the other passed
 * `validProjectId || null` unconditionally, so a project with extraction
 * explicitly OFF still accumulated project-scoped memories.
 *
 * These assertions are deliberately STATIC — reading the source rather than
 * exercising it. A behavioural test can be satisfied by mocking one pipeline
 * out; the property worth defending is that a second pipeline cannot be
 * reintroduced at all.
 *
 * Run: cd server && node --test agents/memory/singleExtractor.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const { listTreeDir } = require('../../moduleRoots.cjs');
const { treeJsFiles, treeFile, readTreeFile } = require('../../testUtils/serverTree');

const SKIP_DIRS = ['data', 'uploads'];

/** Strip comments so a mention in prose is not mistaken for a call. */
function stripComments(/** @type {string} */ src) {
    return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

/**
 * The direct-chat route, as one source. `routes/ai/directChat.js` is now a
 * thin mounter — its own docblock says the route bodies live in
 * `routes/ai/directChat/` — so the property "direct chat runs extraction
 * once" is a property of that whole directory, not of the mounter file.
 */
function directChatSource() {
    const files = [readTreeFile('routes/ai/directChat.js')];
    // The route bodies, and the use cases they call (usecases/ keeps the sub-folder), in every root.
    for (const dir of ['routes/ai/directChat', 'usecases/ai/directChat']) {
        for (const entry of listTreeDir(dir)) {
            if (entry.name.endsWith('.js') && !entry.name.endsWith('.test.js')) files.push(fs.readFileSync(entry.abs, 'utf8'));
        }
    }
    return stripComments(files.join('\n'));
}

test('the retired extractor is gone', () => {
    assert.strictEqual(treeFile('core/memoryExtractor.js'), null, 'core/memoryExtractor.js must stay deleted');
});

test('nothing in the server tree (every root) requires the retired extractor', () => {
    const offenders = [];
    for (const file of treeJsFiles({ skipDirs: SKIP_DIRS, tests: true, dotNames: false })) {
        if (file.treePath.endsWith('singleExtractor.test.js')) continue;
        const src = stripComments(fs.readFileSync(file.abs, 'utf8'));
        if (/require\(\s*['"][^'"]*core\/memoryExtractor['"]\s*\)/.test(src)) {
            offenders.push(file.treePath);
        }
    }
    assert.deepStrictEqual(offenders, [], 'no module may require the retired extractor');
});

test('direct chat runs extraction exactly once per turn', () => {
    const src = directChatSource();
    const calls = src.match(/extractFromConversation\s*\(/g) || [];
    assert.strictEqual(calls.length, 1, `expected one extraction call, found ${calls.length}`);
});

test('direct chat gates the project id on the project\'s own setting', () => {
    const src = directChatSource();
    // The extraction call and its arguments, up to the closing paren.
    const call = src.slice(src.indexOf('extractFromConversation('));
    const args = call.slice(0, call.indexOf(')') + 1);

    assert.ok(
        !/validProjectId\s*\|\|\s*null/.test(args),
        'the ungated form must not come back — it wrote into projects with extraction off',
    );
    assert.match(args, /extractMemoriesEnabled\s*\?\s*validProjectId/, 'the gate is applied');
});
