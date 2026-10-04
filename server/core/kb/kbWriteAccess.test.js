/**
 * "May this automation WRITE into this knowledge base?"
 *
 * ── THE HOLE ────────────────────────────────────────────────────────
 * `executeKbIngestTool` checked one thing: that the base belonged to the same
 * organisation as the run. So any author of any automation in an organisation
 * could write documents into ANY of that organisation's knowledge bases —
 * including one shared with a group they are not in, and one they have no
 * `manage_knowledge` right over. An automation is a program somebody else may run;
 * that was a write nobody reviewed reaching a base nobody agreed to.
 *
 * Reading is a different, weaker question (core/kb/kbVisibility). Being able
 * to read a base is not permission to put things in it: content in a knowledge
 * base is content an agent will state as fact.
 *
 * Run: cd server && node --test --test-force-exit core/kb/kbWriteAccess.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const { canWriteToKb, messageFor, REASONS } = require('./kbWriteAccess');

const realStore = require('../../stores/knowledgeBases');

function kb(id, over = {}) {
    return { id, name: `KB ${id}`, tenant_id: 'owner', organization_id: 'org1', is_published: true, ...over };
}

/** The real policy predicate over a fake table — the policy is not what is under test. */
function storeOf(rows) {
    const byId = new Map(rows.map(r => [r.id, r]));
    return {
        kbStore: {
            getKB: async (id) => byId.get(id) || null,
            canUserManageKB: realStore.canUserManageKB,
            isSystemKB: realStore.isSystemKB,
        },
    };
}

const IN_ORG = { orgIds: new Set(['org1']) };

test('the owner of a knowledge base may write to it', async () => {
    const deps = storeOf([kb('a')]);
    const r = await canWriteToKb('a', { ...IN_ORG, userId: 'owner', deps });
    assert.strictEqual(r.ok, true);
});

test('a colleague in the same org may NOT, without manage_knowledge', async () => {
    // The hole, in one line: this used to pass on the organisation alone.
    const deps = storeOf([kb('a')]);
    const r = await canWriteToKb('a', { ...IN_ORG, userId: 'colleague', canManage: false, deps });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.reason, REASONS.NO_MANAGE);
});

test('and MAY with it', async () => {
    const deps = storeOf([kb('a')]);
    const r = await canWriteToKb('a', { ...IN_ORG, userId: 'colleague', canManage: true, deps });
    assert.strictEqual(r.ok, true);
});

test('reading is not writing: a published base a colleague can read is still refused', async () => {
    // Content in a knowledge base is content an agent will state as fact.
    const deps = storeOf([kb('a', { is_published: true, shared_groups: '[]' })]);
    assert.strictEqual((await canWriteToKb('a', { ...IN_ORG, userId: 'colleague', deps })).ok, false);
});

test('a base in another organisation is refused', async () => {
    const deps = storeOf([kb('a', { organization_id: 'org2' })]);
    const r = await canWriteToKb('a', { ...IN_ORG, userId: 'colleague', canManage: true, deps });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.reason, REASONS.OTHER_ORG);
});

test("somebody else's personal base is refused, manage_knowledge or not", async () => {
    // manage_knowledge is an ORG right. It does not reach into a personal base.
    const deps = storeOf([kb('a', { organization_id: null, tenant_id: 'someone' })]);
    const r = await canWriteToKb('a', { ...IN_ORG, userId: 'colleague', canManage: true, deps });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.reason, REASONS.PERSONAL);
});

test('a system knowledge base is never written to', async () => {
    // Reference text the product ships, including for an administrator.
    const deps = storeOf([kb('a', { tenant_id: 'system', organization_id: null })]);
    const r = await canWriteToKb('a', { ...IN_ORG, userId: 'owner', canManage: true, deps });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.reason, REASONS.SYSTEM);
});

test('orgIds is coerced to a Set — a null must never mean super-admin', async () => {
    // canUserManageKB reads `orgIds === null` as super admin and returns true
    // for everything. A resolver that failed and returned null would turn this
    // gate off entirely.
    const deps = storeOf([kb('a', { organization_id: 'org_other' })]);
    for (const orgIds of [null, undefined, ['org1'], 'org1']) {
        const r = await canWriteToKb('a', { userId: 'colleague', orgIds, canManage: true, deps });
        assert.strictEqual(r.ok, false, `orgIds ${JSON.stringify(orgIds)}`);
    }
});

test('an id that resolves to nothing is refused, not passed through', async () => {
    const deps = storeOf([]);
    const r = await canWriteToKb('gone', { ...IN_ORG, userId: 'owner', deps });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.reason, REASONS.UNKNOWN);
});

test('no id is no write', async () => {
    const deps = storeOf([kb('a')]);
    assert.strictEqual((await canWriteToKb(null, { ...IN_ORG, userId: 'owner', deps })).ok, false);
    assert.strictEqual((await canWriteToKb('', { ...IN_ORG, userId: 'owner', deps })).ok, false);
});

test('a store that throws refuses rather than allowing', async () => {
    const deps = { kbStore: { getKB: async () => { throw new Error('db down'); }, canUserManageKB: () => true } };
    const r = await canWriteToKb('a', { ...IN_ORG, userId: 'owner', deps });
    assert.strictEqual(r.ok, false);
});

describe_messages();
function describe_messages() {
    test('"no such base" and "not yours" read identically', () => {
        // Telling them apart is a way to discover which knowledge bases exist
        // in an organisation.
        assert.strictEqual(messageFor(REASONS.UNKNOWN), messageFor(REASONS.OTHER_ORG));
        assert.strictEqual(messageFor(REASONS.UNKNOWN), messageFor(REASONS.PERSONAL));
    });

    test('a missing permission says WHICH permission, because that is actionable', () => {
        // The person can see the base; the only thing missing is a right
        // somebody can grant them.
        assert.match(messageFor(REASONS.NO_MANAGE, 'Handboek'), /manage knowledge/);
        assert.match(messageFor(REASONS.NO_MANAGE, 'Handboek'), /Handboek/);
    });

    test('a name is never leaked for a base the person may not know about', () => {
        assert.doesNotMatch(messageFor(REASONS.OTHER_ORG, 'Secret plans'), /Secret plans/);
        assert.doesNotMatch(messageFor(REASONS.UNKNOWN, 'Secret plans'), /Secret plans/);
    });
}

// ── The ingest tool actually calls this gate, before anything is created ────
//
// Same technique as integrations/kbIngestTools.refusal.test.js: swap the
// tool's dependencies in require.cache and call the real executeKbIngestTool,
// instead of regexing its source for call order. A textual "canOwnerWriteToKb
// comes before _ensureAutomationSource" line check would stay green on a gate
// that ran early but never actually stopped anything; asking whether the
// source/ingest side effects fired at all is the property that matters.

const path = require('node:path');
const TOOL_PATH = require.resolve('../../integrations/kbIngestTools');
// Specs below are written exactly as kbIngestTools.js itself writes them
// (relative to server/integrations/), so resolve them from ITS directory —
// this test file lives one level deeper, under core/kb/.
const ID = (m) => require.resolve(path.join(path.dirname(TOOL_PATH), m));

/** Swap a module in the require cache for the duration of `fn`. */
function withModules(mods, fn) {
    const saved = new Map();
    for (const [spec, exportsObj] of Object.entries(mods)) {
        const id = ID(spec);
        saved.set(id, require.cache[id]);
        require.cache[id] = { id, filename: id, loaded: true, exports: exportsObj };
    }
    const toolId = TOOL_PATH;
    const savedTool = require.cache[toolId];
    delete require.cache[toolId];
    return (async () => {
        try {
            return await fn(require(TOOL_PATH));
        } finally {
            for (const [id, mod] of saved) { if (mod) require.cache[id] = mod; else delete require.cache[id]; }
            if (savedTool) require.cache[toolId] = savedTool; else delete require.cache[toolId];
        }
    })();
}

test('the ingest tool checks it at RUN time — a refusal creates nothing', async () => {
    // An automation is saved once and runs for months: rights are taken away,
    // sharing narrows, and the definition itself is data an import or an MCP
    // patch can put an id into.
    const calls = { ensuredSource: 0, ingested: 0 };
    const KB = { id: 'kb1', name: 'Handbook', tenant_id: 'org1', organization_id: 'org1' };
    const res = await withModules({
        '../stores/knowledgeBases': {
            getKB: async () => KB,
            isSystemKB: () => false,
            canUserManageKB: () => false,
        },
        '../core/kb/kbWriteAccess': {
            canOwnerWriteToKb: async () => ({ ok: false, reason: REASONS.NO_MANAGE }),
            messageFor: (r) => 'refused:' + r,
        },
        '../core/kb/sources/ensureSource': {
            ensureKbSource: async () => { calls.ensuredSource++; return { id: 'src1' }; },
        },
        '../core/kb/ingestPrivacy': {
            OUTCOME: { PASS: 'pass', REDACTED: 'redacted', SKIPPED: 'skipped' },
            applyShield: async ({ text }) => ({ outcome: 'pass', text, piiStatus: 'none', piiCategories: null }),
        },
        '../core/kb/kbIngestionHelpers': {
            findDocumentBySourceUri: async () => null,
            deleteDocumentChunks: async () => {},
            ingestDocument: async () => { calls.ingested++; return { document: { id: 'doc-new' }, chunks: 1, status: 'processed' }; },
        },
    }, (tool) => tool.executeKbIngestTool('knowledge_base_ingest',
        { knowledgeBaseId: 'kb1', content: 'text', title: 'T' },
        { orgId: 'org1', userId: 'colleague' }));

    assert.ok(res.error, 'a denied writer must get an error back');
    assert.ok(!res.ok);
    assert.strictEqual(calls.ensuredSource, 0, 'the kb_sources bookkeeping row must not be created for a refused write');
    assert.strictEqual(calls.ingested, 0, 'and nothing reaches the ingest pipeline either');
});
