/**
 * Concept/live split (A1) at store level: getForRuntime, publishAgentVersion,
 * the published-list projection and the skill scrub across both columns.
 * `../../db`, `./initSchema`, `./agentTools` and `../versionStore` are mocked
 * via the Module._resolveFilename harness (mirrors agentCrud.test.js).
 *
 * Run: cd server && node --test --test-force-exit stores/agent/agentCrud.published.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');

// ── In-memory "agents" table ────────────────────────────────────────
const table = new Map();

function seed(id, extra = {}) {
    table.set(id, {
        id, owner_id: 'owner', name: 'seed', rev: 1, is_published: true,
        system_prompt: 'live prompt', config: JSON.stringify({ knowledge_base_ids: ['kb-live'], attachedSkillIds: ['s1'] }),
        shared_groups: '[]', organization_id: null,
        published_config: null, published_system_prompt: null, published_version: 0, published_rev: null, published_at: null,
        ...extra,
    });
}
const clone = (r) => (r ? { ...r } : null);
const runs = [];
// agentCrud destructures the db helpers at load time, so a per-test spy has to
// live inside the mock rather than replace mockDb.getOne afterwards.
const counters = { rowReads: 0 };

const mockDb = {
    async exec() {},
    async getOne(sql, params) {
        if (/^SELECT \* FROM agents WHERE id = \$1/.test(sql)) { counters.rowReads++; return clone(table.get(params[0])); }
        if (/^SELECT rev FROM agents WHERE id = \$1/.test(sql)) { const r = table.get(params[0]); return r ? { rev: r.rev } : null; }
        return null;
    },
    async getAll(sql, params) {
        if (/FROM agents WHERE is_published = TRUE/.test(sql) || /FROM agents a WHERE a\.is_published = TRUE/.test(sql)) {
            return [...table.values()].filter(r => r.is_published && !['system', 'swarm'].includes(r.owner_id)).map(clone);
        }
        if (/SELECT id, config, published_config FROM agents/.test(sql)) {
            const needle = params[params.length - 1].replace(/%/g, '');
            return [...table.values()]
                .filter(r => String(r.config || '').includes(needle) || JSON.stringify(r.published_config || '').includes(needle))
                .map(clone);
        }
        if (/SELECT id, "organizationId" FROM groups/.test(sql)) return [];
        return [];
    },
    async run(sql, params) {
        runs.push({ sql, params });
        // Both branches below are recognised by the assignment that only they
        // make, never by where it sits in the SET list: clause order is not
        // part of what an UPDATE means.
        if (/published_version = published_version \+ 1/.test(sql)) {
            const [cfg, id, rev] = params;
            const row = table.get(id);
            if (!row || row.rev !== rev || ['system', 'swarm'].includes(row.owner_id)) return { rowCount: 0, rows: [] };
            row.published_config = JSON.parse(cfg);
            row.published_system_prompt = row.system_prompt;
            row.published_version = (row.published_version || 0) + 1;
            row.published_rev = row.rev;
            row.published_at = '2026-09-04T00:00:00.000Z';
            return { rowCount: 1, rows: [clone(row)] };
        }
        if (/^UPDATE agents SET /.test(sql) && /(?<!published_)rev = rev \+ 1/.test(sql)) {
            const id = params[params.length - 1];
            const row = table.get(id);
            if (!row) return { rowCount: 0, rows: [] };
            row.rev += 1;
            const cfgIdx = sql.match(/config = \$(\d)(?!::)/);
            const pubIdx = sql.match(/published_config = \$(\d)::jsonb/);
            if (cfgIdx) row.config = params[Number(cfgIdx[1]) - 1];
            if (pubIdx) row.published_config = JSON.parse(params[Number(pubIdx[1]) - 1]);
            return { rowCount: 1, rows: [] };
        }
        return { rowCount: 0, rows: [] };
    },
};

const MOCKS = {
    '../../db': mockDb,
    './initSchema': { initDB: async () => {} },
    '../versionStore': { async createVersion() {} },
    './agentTools': {
        getAgentTools: async () => ['comp-1'],
        getAgentToolsWithParams: async () => [{ componentId: 'comp-1', params: null }],
        getAgentToolsBatch: async (ids) => new Map(ids.map(id => [id, ['comp-1']])),
        getAgentToolsWithParamsBatch: async (ids) => new Map(ids.map(id => [id, [{ componentId: 'comp-1', params: null }]])),
    },
};
const MOCK_IDS = {};
for (const [request, exportsObj] of Object.entries(MOCKS)) {
    const mockId = `mock:agentcrud-published:${request}`;
    MOCK_IDS[request] = mockId;
    require.cache[mockId] = { id: mockId, filename: mockId, loaded: true, exports: exportsObj };
}
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    if (parent && /agentCrud\.js$/.test(parent.filename) && Object.prototype.hasOwnProperty.call(MOCK_IDS, request)) {
        return MOCK_IDS[request];
    }
    return originalResolve.call(this, request, parent, ...rest);
};

const agentCrud = require('./agentCrud');

test.beforeEach(() => { table.clear(); runs.length = 0; counters.rowReads = 0; });
test.after(() => { Module._resolveFilename = originalResolve; });

// ── getForRuntime ───────────────────────────────────────────────────

test('never published → live concept, runtimeSource live', async () => {
    seed('a1');
    const a = await agentCrud.getForRuntime('a1');
    assert.strictEqual(a.runtimeSource, 'live');
    assert.strictEqual(a.system_prompt, 'live prompt');
    assert.deepStrictEqual(a.config.knowledge_base_ids, ['kb-live']);
    assert.deepStrictEqual(a.tools, ['comp-1']);
    assert.ok(!('published_config' in a) && !('published_system_prompt' in a), 'blobs never leave the store');
    assert.strictEqual(a.published_version, 0, 'scalar published_* columns pass through');
});

test('published → published_* served, concept ignored', async () => {
    seed('a1', {
        rev: 7, published_version: 2, published_rev: 5,
        published_config: { knowledge_base_ids: ['kb-pub'] }, published_system_prompt: 'published prompt',
    });
    const a = await agentCrud.getForRuntime('a1');
    assert.strictEqual(a.runtimeSource, 'published');
    assert.strictEqual(a.system_prompt, 'published prompt');
    assert.deepStrictEqual(a.config, { knowledge_base_ids: ['kb-pub'] });
    assert.strictEqual(a.rev, 7, 'rev stays the live CAS token');
    // getAgent (the editor) still sees the concept.
    const draft = await agentCrud.getAgent('a1');
    assert.strictEqual(draft.system_prompt, 'live prompt');
    assert.ok(!('runtimeSource' in draft));
});

test("owner_id='system' always follows live, even with published_* filled", async () => {
    seed('sys', { owner_id: 'system', published_version: 3, published_config: { x: 1 }, published_system_prompt: 'stale' });
    const a = await agentCrud.getForRuntime('sys');
    assert.strictEqual(a.runtimeSource, 'live');
    assert.strictEqual(a.system_prompt, 'live prompt');
});

test('published_version > 0 but NULL blob → live (never serve a half-written row)', async () => {
    seed('a1', { published_version: 1, published_config: null });
    const a = await agentCrud.getForRuntime('a1');
    assert.strictEqual(a.runtimeSource, 'live');
});

test('unknown id → null', async () => {
    assert.strictEqual(await agentCrud.getForRuntime('nope'), null);
});

// ── getForRuntime({ useDraft }) — de testchat (A4) ───────────────────
// Alleen wie er expliciet om vraagt krijgt het concept. Dat is de hele
// veiligheidsklep: elke bestaande aanroep (chat, embed, support-responder,
// AI-stap) roept zonder opties aan en blijft dus op de gepubliceerde blob.

test('useDraft serves the CONCEPT even when a published blob exists', async () => {
    seed('a1', {
        rev: 9, published_version: 2, published_rev: 4,
        published_config: { knowledge_base_ids: ['kb-published'] },
        published_system_prompt: 'published prompt',
    });

    const draft = await agentCrud.getForRuntime('a1', { useDraft: true });
    assert.strictEqual(draft.runtimeSource, 'draft');
    assert.strictEqual(draft.system_prompt, 'live prompt');
    assert.deepStrictEqual(draft.config.knowledge_base_ids, ['kb-live']);
    // De versiekolommen reizen mee — daar rekent het scherm op om te zeggen
    // "dit is je concept, live staat v2".
    assert.strictEqual(draft.published_version, 2);
    assert.strictEqual(draft.published_rev, 4);
    assert.strictEqual(draft.rev, 9);
    assert.ok(!('published_config' in draft) && !('published_system_prompt' in draft),
        'asking for the draft must not double the payload with the published blobs');
});

test('the same row without the option is still the PUBLISHED projection', async () => {
    seed('a1', {
        published_version: 2, published_rev: 4,
        published_config: { knowledge_base_ids: ['kb-published'] },
        published_system_prompt: 'published prompt',
    });
    for (const opts of [undefined, {}, { useDraft: false }, { useDraft: 'true' }, { useDraft: 1 }]) {
        const a = await agentCrud.getForRuntime('a1', opts);
        assert.strictEqual(a.runtimeSource, 'published', `opts: ${JSON.stringify(opts)}`);
        assert.strictEqual(a.system_prompt, 'published prompt');
    }
});

test('useDraft on a never-published agent is still marked draft, not live', async () => {
    // 'live' betekent "er is niets gepubliceerd om van te verschillen" en
    // 'draft' betekent "je vroeg om je concept". Voor een agent zonder
    // publicatie is de INHOUD gelijk, maar het scherm moet die twee zinnen
    // uit elkaar kunnen houden.
    seed('a1');
    const draft = await agentCrud.getForRuntime('a1', { useDraft: true });
    assert.strictEqual(draft.runtimeSource, 'draft');
    assert.strictEqual((await agentCrud.getForRuntime('a1')).runtimeSource, 'live');
});

test('projectDraft is pure: no blobs out, draft in, row untouched', () => {
    const row = {
        id: 'a1', config: '{"a":1}', system_prompt: 'live',
        published_config: { a: 2 }, published_system_prompt: 'pub', published_version: 3,
    };
    const out = agentCrud.projectDraft(row);
    assert.strictEqual(out.runtimeSource, 'draft');
    assert.strictEqual(out.config, '{"a":1}');
    assert.strictEqual(out.system_prompt, 'live');
    assert.ok(!('published_config' in out));
    assert.ok(!('published_system_prompt' in out));
    assert.strictEqual(row.published_config.a, 2, 'the caller\'s row is not mutated');
    assert.strictEqual(agentCrud.projectDraft(null), null);
});

// ── getAgentViews (one load, both views) ────────────────────────────

test('getAgentViews returns concept + projection from a single row read', async () => {
    seed('a1', {
        rev: 7, published_version: 2, published_rev: 5,
        published_config: { knowledge_base_ids: ['kb-pub'] }, published_system_prompt: 'published prompt',
    });
    const views = await agentCrud.getAgentViews('a1');
    assert.strictEqual(counters.rowReads, 1, 'the row is read once for both views');
    assert.strictEqual(views.draft.system_prompt, 'live prompt');
    assert.deepStrictEqual(views.draft.config.knowledge_base_ids, ['kb-live']);
    assert.ok(!('runtimeSource' in views.draft));
    assert.strictEqual(views.runtime.system_prompt, 'published prompt');
    assert.strictEqual(views.runtime.runtimeSource, 'published');
    assert.ok(!('published_config' in views.runtime) && !('published_config' in views.draft));
    assert.deepStrictEqual(views.draft.tools, ['comp-1']);
    assert.deepStrictEqual(views.runtime.tools, ['comp-1']);
});

test('getAgentViews on an unknown id → null', async () => {
    assert.strictEqual(await agentCrud.getAgentViews('nope'), null);
});

// ── publishAgentVersion ─────────────────────────────────────────────

test('publish copies the concept, bumps published_version, sets published_rev, leaves rev alone', async () => {
    seed('a1', { rev: 4 });
    const r = await agentCrud.publishAgentVersion('a1', { expectedRev: 4 });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.publishedVersion, 1);
    assert.strictEqual(r.publishedRev, 4);
    const row = table.get('a1');
    assert.strictEqual(row.rev, 4, 'publishing is not a concept change');
    assert.deepStrictEqual(row.published_config, { knowledge_base_ids: ['kb-live'], attachedSkillIds: ['s1'] });
    assert.strictEqual(row.published_system_prompt, 'live prompt');
    const rt = await agentCrud.getForRuntime('a1');
    assert.strictEqual(rt.runtimeSource, 'published');
});

test('a second publish increments published_version', async () => {
    seed('a1', { rev: 4 });
    await agentCrud.publishAgentVersion('a1', { expectedRev: 4 });
    table.get('a1').rev = 6; // two more saves
    const r = await agentCrud.publishAgentVersion('a1', { expectedRev: 6 });
    assert.strictEqual(r.publishedVersion, 2);
    assert.strictEqual(r.publishedRev, 6);
});

test('an explicit config wins over the stored concept (validated copy)', async () => {
    seed('a1', { rev: 1 });
    await agentCrud.publishAgentVersion('a1', { expectedRev: 1, config: { attachedSkillIds: [] } });
    assert.deepStrictEqual(table.get('a1').published_config, { attachedSkillIds: [] });
});

test('stale expectedRev → conflict with currentRev, nothing written', async () => {
    seed('a1', { rev: 9 });
    const r = await agentCrud.publishAgentVersion('a1', { expectedRev: 3 });
    assert.deepStrictEqual(r, { ok: false, conflict: true, currentRev: 9 });
    assert.strictEqual(table.get('a1').published_version, 0);
});

test('system agent → systemAgent, not published', async () => {
    seed('sys', { owner_id: 'system' });
    const r = await agentCrud.publishAgentVersion('sys', {});
    assert.deepStrictEqual(r, { ok: false, systemAgent: true });
    assert.strictEqual(table.get('sys').published_version, 0);
});

test('missing agent → notFound', async () => {
    const r = await agentCrud.publishAgentVersion('nope', {});
    assert.deepStrictEqual(r, { ok: false, notFound: true });
});

// ── the library serves the runtime projection ───────────────────────

test('getPublishedAgents / getPublishedAgentsForUser serve published_* once published', async () => {
    seed('a1', { published_version: 1, published_rev: 1, published_config: { knowledge_base_ids: ['kb-pub'] }, published_system_prompt: 'pub' });
    seed('a2'); // never published → live
    for (const list of [await agentCrud.getPublishedAgents(), await agentCrud.getPublishedAgentsForUser([], null, null)]) {
        assert.ok(Array.isArray(list));
        const a1 = list.find(a => a.id === 'a1');
        const a2 = list.find(a => a.id === 'a2');
        assert.strictEqual(a1.system_prompt, 'pub');
        assert.deepStrictEqual(a1.config, { knowledge_base_ids: ['kb-pub'] });
        assert.strictEqual(a1.runtimeSource, 'published');
        assert.strictEqual(a2.system_prompt, 'live prompt');
        assert.strictEqual(a2.runtimeSource, 'live');
        for (const a of list) assert.ok(!('published_config' in a));
    }
});

// ── skill scrub reaches the published copy ──────────────────────────

test('scrubSkillFromAllAgents removes the skill from config AND published_config', async () => {
    seed('a1', {
        config: JSON.stringify({ attachedSkillIds: ['s1', 's2'] }),
        published_version: 1, published_config: { attachedSkillIds: ['s1', 's3'] },
    });
    seed('a2', { config: JSON.stringify({ attachedSkillIds: ['s9'] }) });
    const n = await agentCrud.scrubSkillFromAllAgents(null, 's1');
    assert.strictEqual(n, 1);
    assert.deepStrictEqual(JSON.parse(table.get('a1').config).attachedSkillIds, ['s2']);
    assert.deepStrictEqual(table.get('a1').published_config.attachedSkillIds, ['s3']);
    assert.strictEqual(table.get('a1').published_version, 1, 'a scrub is a hotfix, not a new version');
});

test('scrub touches published_config even when the concept no longer references the skill', async () => {
    seed('a1', {
        config: JSON.stringify({ attachedSkillIds: [] }),
        published_version: 1, published_config: { attachedSkillIds: ['s1'] },
    });
    const n = await agentCrud.scrubSkillFromAllAgents(null, 's1');
    assert.strictEqual(n, 1);
    assert.deepStrictEqual(table.get('a1').published_config.attachedSkillIds, []);
    assert.deepStrictEqual(JSON.parse(table.get('a1').config).attachedSkillIds, []);
});
