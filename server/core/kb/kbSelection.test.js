/**
 * `resolveUsableKbIds` — the pair of questions that has to be answered before a
 * knowledge base is allowed to contribute anything, and the direction it fails
 * in.
 *
 * The point of this file is the REFUSALS. The happy path is one test; the rest
 * pin that every way this can go wrong makes the answer SMALLER:
 *
 *   - a base belonging to somebody else is dropped, even when the caller names
 *     it explicitly
 *   - a base its owner switched off for this surface is dropped, even though
 *     the caller may read it
 *   - `orgIds: null` must NOT read as super-admin — canUserAccessKB treats null
 *     that way and it would switch the whole filter off
 *   - a knowledge-base store that throws yields NOTHING, not everything
 *   - the check itself throwing yields NOTHING, not the input list
 *
 * Runs against the REAL filterKbIdsForUser and the REAL canUserAccessKB — only
 * the row lookup is a fixture, so this cannot pass by re-implementing the
 * policy it is supposed to be testing.
 *
 * Run: cd server && node --test --test-force-exit core/kb/kbSelection.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

process.env.NODE_ENV = 'test';

// ── Fixture knowledge bases ───────────────────────────────────────
// `usage_contexts` null = "never expressed" = every surface (usageContexts.js).
const KBS = {
    // Alice's own, usable in chat.
    'kb-mine': { id: 'kb-mine', tenant_id: 'alice', organization_id: 'org-1', is_published: true, shared_groups: '[]', usage_contexts: ['direct_chat', 'agent'] },
    // Alice's own, but its owner limited it to automations.
    'kb-mine-ai-step-only': { id: 'kb-mine-ai-step-only', tenant_id: 'alice', organization_id: 'org-1', is_published: true, shared_groups: '[]', usage_contexts: ['ai_step'] },
    // Predates the column: no surface was ever expressed.
    'kb-legacy': { id: 'kb-legacy', tenant_id: 'alice', organization_id: 'org-1', is_published: true, shared_groups: '[]', usage_contexts: null },
    // Another tenant entirely.
    'kb-foreign': { id: 'kb-foreign', tenant_id: 'bob', organization_id: 'org-2', is_published: true, shared_groups: '[]', usage_contexts: null },
    // Same org, but a draft.
    'kb-draft': { id: 'kb-draft', tenant_id: 'bob', organization_id: 'org-1', is_published: false, shared_groups: '[]', usage_contexts: null },
    // Same org, published, restricted to a group Alice is not in.
    'kb-group': { id: 'kb-group', tenant_id: 'bob', organization_id: 'org-1', is_published: true, shared_groups: '["group-x"]', usage_contexts: null },
};

let kbStoreBehaviour = 'ok'; // 'ok' | 'throws'

const kbStorePath = require.resolve('../../stores/knowledgeBases');
const realKbStore = require('../../stores/knowledgeBases');
require.cache[kbStorePath] = {
    id: kbStorePath,
    filename: kbStorePath,
    loaded: true,
    exports: {
        getKB: async (id) => {
            if (kbStoreBehaviour === 'throws') throw new Error('knowledge_bases is down');
            return KBS[id] || null;
        },
        // The REAL policy function — this test must not re-implement it.
        canUserAccessKB: realKbStore.canUserAccessKB,
    },
};

const { resolveUsableKbIds, normaliseKbIds, MAX_ATTACHED_KB_IDS } = require('./kbSelection');

const ALICE = { userId: 'alice', orgIds: new Set(['org-1']), userGroups: [] };

test.beforeEach(() => { kbStoreBehaviour = 'ok'; });

// ═══ The one happy path ═══════════════════════════════════════════

test('a base the asker may read and that allows this surface survives', async () => {
    assert.deepStrictEqual(await resolveUsableKbIds(['kb-mine'], ALICE), ['kb-mine']);
});

test('a base with no usage_contexts is usable everywhere, not nowhere', async () => {
    assert.deepStrictEqual(await resolveUsableKbIds(['kb-legacy'], ALICE), ['kb-legacy']);
});

// ═══ The refusals ═════════════════════════════════════════════════

test('a stranger id is dropped, and dropping it does not take the rest with it', async () => {
    const out = await resolveUsableKbIds(['kb-mine', 'kb-foreign'], ALICE);
    assert.deepStrictEqual(out, ['kb-mine']);
});

test('a guessed uuid that resolves to nothing is dropped', async () => {
    assert.deepStrictEqual(await resolveUsableKbIds(['kb-does-not-exist'], ALICE), []);
});

test('a same-org draft and a group-restricted base are both dropped', async () => {
    assert.deepStrictEqual(await resolveUsableKbIds(['kb-draft', 'kb-group'], ALICE), []);
});

test('a base its owner limited to another surface is dropped even though it is readable', async () => {
    // Readable: it is Alice's own base. Still refused here — usage_contexts is
    // the owner's surface answer, and it says automations only.
    assert.deepStrictEqual(await resolveUsableKbIds(['kb-mine-ai-step-only'], ALICE), []);
    // ...and it IS accepted on the surface it was meant for, so this is a
    // surface test and not an accidental access failure.
    assert.deepStrictEqual(
        await resolveUsableKbIds(['kb-mine-ai-step-only'], { ...ALICE, surface: 'ai_step' }),
        ['kb-mine-ai-step-only']
    );
});

test('orgIds null does NOT read as super admin', async () => {
    // canUserAccessKB treats a null orgIds as "super admin, allow everything".
    // A resolver that failed and handed back null must therefore narrow, never
    // widen: the other tenant's base stays out.
    const out = await resolveUsableKbIds(['kb-foreign', 'kb-mine'], { userId: 'alice', orgIds: null, userGroups: [] });
    assert.deepStrictEqual(out, ['kb-mine']);
});

test('org ids are coerced to a Set BEFORE they reach the access filter', async () => {
    // Pinned at the seam, not through the outcome: kbVisibility coerces as
    // well, so the test above passes either way and this guard would read as
    // dead code to the next person. It is not — `deps.filterKbIdsForUser` is a
    // real seam, and `canUserAccessKB` turns a null orgIds into "super admin,
    // allow everything".
    const seen = [];
    for (const orgIds of [null, undefined, ['org-1'], new Set(['org-1']), 'org-1']) {
        await resolveUsableKbIds(['kb-mine'], {
            userId: 'alice',
            orgIds,
            deps: { filterKbIdsForUser: async (ids, opts) => { seen.push(opts.orgIds); return []; } },
        });
    }
    assert.strictEqual(seen.length, 5);
    for (const s of seen) assert.ok(s instanceof Set, `handed ${JSON.stringify(s)} instead of a Set`);
});

test('an anonymous caller gets nothing', async () => {
    const out = await resolveUsableKbIds(['kb-mine', 'kb-legacy'], { userId: null, orgIds: new Set(), userGroups: [] });
    assert.deepStrictEqual(out, []);
});

// ═══ Fail closed: an unanswerable question is not a grant ═════════

test('a knowledge-base store that throws yields NOTHING, not everything', async () => {
    kbStoreBehaviour = 'throws';
    assert.deepStrictEqual(await resolveUsableKbIds(['kb-mine', 'kb-legacy'], ALICE), []);
});

test('the visibility filter itself throwing yields NOTHING, not the input list', async () => {
    const out = await resolveUsableKbIds(['kb-mine'], {
        ...ALICE,
        deps: { filterKbIdsForUser: async () => { throw new Error('policy module exploded'); } },
    });
    assert.deepStrictEqual(out, []);
});

test('a filter that hands back something that is not a list yields nothing', async () => {
    const out = await resolveUsableKbIds(['kb-mine'], {
        ...ALICE,
        deps: { filterKbIdsForUser: async () => undefined },
    });
    assert.deepStrictEqual(out, []);
});

// ═══ Input hygiene: it can never widen ════════════════════════════

test('non-arrays, blanks and non-strings resolve to an empty list', async () => {
    for (const input of [undefined, null, 'kb-mine', {}, [], [null, 42, '', '   ', {}]]) {
        assert.deepStrictEqual(await resolveUsableKbIds(input, ALICE), [], `input: ${JSON.stringify(input)}`);
    }
});

test('normaliseKbIds trims, de-duplicates and caps', () => {
    assert.deepStrictEqual(normaliseKbIds([' a ', 'a', 'b', '', null, 7]), ['a', 'b']);
    const many = Array.from({ length: MAX_ATTACHED_KB_IDS + 25 }, (_, i) => `kb-${i}`);
    assert.strictEqual(normaliseKbIds(many).length, MAX_ATTACHED_KB_IDS);
});

test('the output is always a subset of the input, never an addition', async () => {
    const out = await resolveUsableKbIds(['kb-mine', 'kb-foreign', 'kb-legacy'], ALICE);
    for (const id of out) assert.ok(['kb-mine', 'kb-foreign', 'kb-legacy'].includes(id));
    assert.deepStrictEqual(out, ['kb-mine', 'kb-legacy']); // order preserved
});
