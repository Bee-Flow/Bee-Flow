/**
 * `knowledge_write` — the step that puts text into a knowledge base.
 *
 * What the tests are really pinning, in order of what would hurt most:
 *
 *   1. A DRY RUN WRITES NOTHING. Every other step's dry run is a preview; a
 *      "preview" here would leave a document in a base somebody was only
 *      testing against, and the whole point of a dry run is that you can run
 *      it again.
 *   2. A REFUSAL IS A SKIP, not a thrown error. The commonest one is the
 *      permission gate, which is a configuration problem the author must see
 *      and fix — not a run that fails at 3am and pages somebody.
 *   3. NOTHING TO SAY IS NOT A FAILURE. An upstream step that found nothing
 *      this run is the normal case, and a routine that turns amber every time
 *      is a routine somebody switches off.
 *   4. The identity is the routine's OWNER, so a trigger anyone can fire
 *      cannot become a way to write as somebody else.
 *
 * Run: cd server && node --test --test-force-exit core/automationRunner/execKnowledgeWrite.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

const { MAX_CONTENT_CHARS, MAX_TITLE_CHARS } = require('./execKnowledgeWrite');

/**
 * Run the step with `integrations/kbIngestTools` stubbed.
 *
 * The module is required lazily inside the function, so swapping the entry in
 * the require cache is enough and nothing else in the runner is disturbed.
 */
async function withIngest(impl, fn) {
    const id = require.resolve('../../integrations/kbIngestTools');
    const real = require.cache[id];
    const calls = [];
    require.cache[id] = {
        id, filename: id, loaded: true,
        exports: {
            executeKbIngestTool: async (tool, args, context) => {
                calls.push({ tool, args, context });
                return typeof impl === 'function' ? impl(args, context) : impl;
            },
        },
    };
    // AWAITED, not returned: a `finally` around a returned promise restores the
    // real module at the first suspension point, so every call after the first
    // `await` inside `fn` would reach the real ingest — and a test that thought
    // it was asserting on a stub would be talking to a database.
    try { return await fn(calls); } finally {
        if (real) require.cache[id] = real; else delete require.cache[id];
    }
}

const { execKnowledgeWrite } = require('./execKnowledgeWrite');

const CTX = { userId: 'owner1', orgId: 'org1', automationId: 'a1', automationTitle: 'Tickets → KB' };
const STATE = { steps: { distill: { output: { title: 'How to reset', article: 'Press the button.' } } }, trigger: { output: { id: '42' } } };

const step = (over = {}) => ({
    id: 'w1', type: 'knowledge_write',
    knowledgeBaseId: 'kb1',
    content: '{{steps.distill.output.article}}',
    title: '{{steps.distill.output.title}}',
    sourceUri: 'ticket:{{trigger.output.id}}',
    ...over,
});

test('a live run interpolates the templates and reports what landed', async () => {
    await withIngest({ ok: true, documentId: 'doc1', chunks_created: 3, refreshed: true }, async (calls) => {
        const res = await execKnowledgeWrite(step(), CTX, STATE, 'live');
        assert.deepStrictEqual(calls[0].args, {
            knowledgeBaseId: 'kb1',
            title: 'How to reset',
            content: 'Press the button.',
            sourceUri: 'ticket:42',
            nearDuplicateStrategy: 'skip',
        });
        assert.strictEqual(res.output.written, true);
        assert.strictEqual(res.output.documentId, 'doc1');
        assert.strictEqual(res.output.chunks, 3);
        assert.strictEqual(res.output.refreshed, true, 'so a routine can branch on "was this new"');
    });
});

test('A DRY RUN WRITES NOTHING', async () => {
    await withIngest({ ok: true, documentId: 'doc1' }, async (calls) => {
        const res = await execKnowledgeWrite(step(), CTX, STATE, 'dry_run');
        assert.strictEqual(calls.length, 0, 'the ingest is never called');
        assert.strictEqual(res.output.wouldWrite, true);
        assert.strictEqual(res.output.documentId, null);
        assert.strictEqual(res.output.characters, 'Press the button.'.length);
        assert.strictEqual(res.output.title, 'How to reset', 'the preview shows what it WOULD store');
    });
});

test('a dry run offers the SAME keys a live run does', async () => {
    // Otherwise a downstream branch on steps.<id>.output.written resolves live
    // and to nothing in a dry run — the branch behaves differently precisely
    // because you are testing it.
    await withIngest({ ok: true, documentId: 'doc1', chunks_created: 2 }, async () => {
        const live = await execKnowledgeWrite(step(), CTX, STATE, 'live');
        const dry = await execKnowledgeWrite(step(), CTX, STATE, 'dry_run');
        const missing = Object.keys(live.output).filter(k => !(k in dry.output));
        assert.deepStrictEqual(missing, [], 'a dry run must not drop a key the live path returns');
        assert.strictEqual(dry.output.written, false, 'and it says plainly that nothing was written');
        assert.strictEqual(dry.dryRunSynthesised, true, 'marked so downstream reads synthesise rather than trust it');
    });
});

test('an over-long title is trimmed by CODE POINT, never mid-character', async () => {
    // String.slice cuts at UTF-16 code units and an emoji is two, so a title
    // landing on the boundary was persisted with a lone surrogate.
    await withIngest({ ok: true }, async (calls) => {
        await execKnowledgeWrite(step({ title: 'x'.repeat(MAX_TITLE_CHARS - 1) + '😀' }), CTX, STATE, 'live');
        const t = calls[0].args.title;
        assert.ok(t.endsWith('😀'), 'the last character survives whole');
        assert.strictEqual([...t].length, MAX_TITLE_CHARS, 'and the cap is counted in characters');
        // Spreading yields CODE POINTS, so a lone surrogate shows up as a
        // single char in the surrogate range. (Anchoring a regex at $ would
        // match the emoji's own trailing low surrogate — a correct pair.)
        const lone = [...t].filter(ch => ch.length === 1 && ch.codePointAt(0) >= 0xD800 && ch.codePointAt(0) <= 0xDFFF);
        assert.deepStrictEqual(lone, [], 'never a lone surrogate');
    });
});

test('the write runs as the routine OWNER, with the routine named', async () => {
    // A trigger anyone can fire must not become a way to write as somebody
    // with rights the person firing it does not have.
    await withIngest({ ok: true }, async (calls) => {
        await execKnowledgeWrite(step(), CTX, STATE, 'live');
        assert.strictEqual(calls[0].context.userId, 'owner1');
        assert.strictEqual(calls[0].context.orgId, 'org1');
        assert.strictEqual(calls[0].context.automationId, 'a1');
        assert.strictEqual(calls[0].context.origin, 'routine',
            'filed as a routine write, not as a support ticket');
        assert.strictEqual(calls[0].context.automationTitle, 'Tickets → KB');
    });
});

test('a REFUSAL is a skip with the reason, not a thrown error', async () => {
    await withIngest({ error: 'That knowledge base is not available to this routine.' }, async () => {
        const res = await execKnowledgeWrite(step(), CTX, STATE, 'live');
        // The CODE goes top-level (runDag paints the row amber from it) and the
        // SENTENCE goes on output.skipped, which is where the run view reads it.
        assert.strictEqual(res.skippedReason, 'knowledge_write_refused');
        assert.match(res.output.skipped, /not available to this routine/);
        assert.strictEqual(res.output.written, false, 'so a downstream branch can see it did not land');
    });
});

test('nothing to write this run is a SKIP, not a failure', async () => {
    // The usual reason is an upstream step that found nothing — a ticket with
    // no resolution yet, a summary that did not generate.
    await withIngest({ ok: true }, async (calls) => {
        for (const content of ['{{steps.missing.output.text}}', '   ', '']) {
            const res = await execKnowledgeWrite(step({ content }), CTX, STATE, 'live');
            assert.strictEqual(res.skippedReason, 'knowledge_write_empty', JSON.stringify(content));
            assert.strictEqual(res.output.written, false, 'and it stays bindable');
        }
        assert.strictEqual(calls.length, 0, 'an empty document is never stored');
    });
});

test('every skip leaves a bindable output, so a branch on it keeps working', async () => {
    // A routine that reacts to "did this land" must not crash on the run where
    // it did not — which is the only run that branch exists for.
    await withIngest({ error: 'nope' }, async () => {
        for (const over of [{ knowledgeBaseId: '' }, { content: '' }, { content: 'x'.repeat(MAX_CONTENT_CHARS + 1) }, {}]) {
            const res = await execKnowledgeWrite(step(over), CTX, STATE, 'live');
            assert.strictEqual(res.output.written, false, JSON.stringify(over));
            assert.strictEqual(typeof res.output.skipped, 'string', 'and it says why');
        }
    });
});

test('a step with no base yet skips rather than calling the ingest', async () => {
    await withIngest({ ok: true }, async (calls) => {
        const res = await execKnowledgeWrite(step({ knowledgeBaseId: '' }), CTX, STATE, 'live');
        assert.strictEqual(res.skippedReason, 'knowledge_write_no_kb');
        assert.strictEqual(calls.length, 0);
    });
});

test('text beyond what a document holds is refused, not truncated', async () => {
    // Silently storing the first 200k of a 2M-character run would produce a
    // knowledge base that answers from half a document, with nothing to say so.
    await withIngest({ ok: true }, async (calls) => {
        const res = await execKnowledgeWrite(
            step({ content: 'x'.repeat(MAX_CONTENT_CHARS + 1) }), CTX, STATE, 'live');
        assert.strictEqual(res.skippedReason, 'knowledge_write_too_long');
        assert.strictEqual(calls.length, 0);
    });
});

test('an over-long title is trimmed — it is a label, not the content', async () => {
    await withIngest({ ok: true }, async (calls) => {
        await execKnowledgeWrite(step({ title: 'y'.repeat(MAX_TITLE_CHARS + 50) }), CTX, STATE, 'live');
        assert.strictEqual(calls[0].args.title.length, MAX_TITLE_CHARS);
    });
});

test('an untitled write still gets a title', async () => {
    await withIngest({ ok: true }, async (calls) => {
        await execKnowledgeWrite(step({ title: '' }), CTX, STATE, 'live');
        assert.strictEqual(calls[0].args.title, 'Untitled');
    });
});

test('an empty source reference travels as null, not as ""', async () => {
    // The ingest branches on `if (sourceUri)`; an empty string would look like
    // a reference and find no document, which is the same as none but slower.
    await withIngest({ ok: true }, async (calls) => {
        await execKnowledgeWrite(step({ sourceUri: '' }), CTX, STATE, 'live');
        assert.strictEqual(calls[0].args.sourceUri, null);
    });
});

test('a strategy nothing implements falls back to the safe one', async () => {
    await withIngest({ ok: true }, async (calls) => {
        await execKnowledgeWrite(step({ nearDuplicateStrategy: 'obliterate' }), CTX, STATE, 'live');
        assert.strictEqual(calls[0].args.nearDuplicateStrategy, 'skip',
            'keeping what is there is the only safe default');
    });
});

test('every declared strategy is passed through as given', async () => {
    await withIngest({ ok: true }, async (calls) => {
        for (const s of ['skip', 'merge', 'replace', 'add']) {
            await execKnowledgeWrite(step({ nearDuplicateStrategy: s }), CTX, STATE, 'live');
        }
        assert.deepStrictEqual(calls.map(c => c.args.nearDuplicateStrategy), ['skip', 'merge', 'replace', 'add']);
    });
});

test('a binding OBJECT still resolves — a definition is data', async () => {
    // Nothing this product writes produces one, but an import or an MCP patch
    // can carry the shape an older tool used.
    await withIngest({ ok: true }, async (calls) => {
        await execKnowledgeWrite(
            step({ content: { kind: 'ref', path: 'steps.distill.output.article' } }), CTX, STATE, 'live');
        assert.strictEqual(calls[0].args.content, 'Press the button.');
    });
});

test('a secret can never be written into a knowledge base — BY EITHER PATH', async () => {
    /**
     * A knowledge base is the LAST place a credential should land: an agent
     * would quote it back, with a citation, to whoever asked.
     *
     * Both shapes, because only one of them was safe. `resolveValue` strips
     * secrets when asked; `interpolateTemplate` reads whatever state it is
     * handed, so a `{{secrets.x}}` typed into the TEMPLATE field — the shape
     * the editor's text areas actually produce — went straight through.
     */
    await withIngest({ ok: true }, async (calls) => {
        const state = { ...STATE, secrets: { api_key: 'sk-live-42' } };
        const shapes = [
            { kind: 'ref', path: 'secrets.api_key' },
            '{{secrets.api_key}}',
            'key: {{secrets.api_key}}',
        ];
        for (const content of shapes) {
            const res = await execKnowledgeWrite(step({ content, sourceUri: '' }), CTX, state, 'live');
            const stored = JSON.stringify(calls.map(c => c.args));
            assert.ok(!stored.includes('sk-live-42'), `a secret reached the ingest via ${JSON.stringify(content)}`);
            assert.ok(res.skippedReason || !res.output.written === false,
                'and the step does not silently store the surrounding text as if it were complete');
        }
    });
});

test('a dry run cannot be used to read a secret back either', async () => {
    // The preview reports a character count and the title. A `{{secrets.x}}`
    // in the title would be echoed into the run row where anyone who can open
    // the run can read it.
    await withIngest({ ok: true }, async () => {
        const state = { ...STATE, secrets: { api_key: 'sk-live-42' } };
        const res = await execKnowledgeWrite(
            step({ title: '{{secrets.api_key}}', content: 'real text' }), CTX, state, 'dry_run');
        assert.ok(!JSON.stringify(res.output).includes('sk-live-42'));
    });
});
