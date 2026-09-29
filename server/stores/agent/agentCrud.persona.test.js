/**
 * The structured role at STORE level (A1c): who gets a persona, who never
 * does, and the undefined-means-preserve rule on the way in.
 *
 * The two properties worth a test each:
 *   - `persona` is an EDITOR artefact. `parseConfig` strips the raw column, so
 *     it can only appear where this file deliberately puts it — never on a
 *     list, a runtime projection or the published library, all of which are
 *     built from `SELECT *`.
 *   - the write follows the same rule the three other optional columns learned
 *     the hard way: an argument nobody supplied preserves, it does not clear.
 *
 * `../../db`, `./initSchema`, `./agentTools` and `../versionStore` are mocked
 * through the Module._resolveFilename harness (mirrors agentCrud.published.test.js).
 *
 * Run: cd server && node --test --test-force-exit stores/agent/agentCrud.persona.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');

const table = new Map();
const runs = [];
const versionCalls = [];

function seed(id, extra = {}) {
    table.set(id, {
        id, owner_id: 'owner', name: 'seed', rev: 1, is_published: true,
        system_prompt: 'the live prompt', config: JSON.stringify({ knowledge_base_ids: [] }),
        shared_groups: '[]', organization_id: null, persona: null,
        published_config: null, published_system_prompt: null, published_version: 0, published_rev: null, published_at: null,
        ...extra,
    });
}
const clone = (r) => (r ? { ...r } : null);

const mockDb = {
    async exec() {},
    async getOne(sql, params) {
        if (/^SELECT \* FROM agents WHERE id = \$1/.test(sql)) return clone(table.get(params[0]));
        if (/^SELECT rev, owner_id FROM agents WHERE id = \$1/.test(sql)) {
            const r = table.get(params[0]);
            return r ? { rev: r.rev, owner_id: r.owner_id } : null;
        }
        return null;
    },
    async getAll(sql) {
        if (/FROM agents WHERE owner_id = \$1/.test(sql)) return [...table.values()].map(clone);
        if (/FROM agents a WHERE a\.is_published = TRUE/.test(sql)) {
            return [...table.values()].filter(r => r.is_published).map(clone);
        }
        if (/SELECT id, "organizationId" FROM groups/.test(sql)) return [];
        return [];
    },
    async run(sql, params) {
        runs.push({ sql, params });
        if (/^INSERT INTO agents/.test(sql)) {
            // Column list ends with `persona` — the last bound parameter.
            const personaJson = params[params.length - 1];
            table.set(params[0], {
                id: params[0], owner_id: params[13], name: params[1], rev: 1,
                system_prompt: params[3], config: params[9], shared_groups: params[11],
                organization_id: params[10], persona: personaJson ? JSON.parse(personaJson) : null,
                published_config: null, published_version: 0,
            });
            return { rowCount: 1, rows: [] };
        }
        if (/^UPDATE agents SET name=/.test(sql)) {
            const row = table.get(params[14]);
            if (!row || row.owner_id !== params[15]) return { rowCount: 0 };
            // The CAS guard, read from the STATEMENT — so a persona clause that
            // shifted the placeholder numbers shows up here as a lost conflict.
            const guard = sql.match(/AND rev = \$(\d+)/);
            if (guard && row.rev !== params[Number(guard[1]) - 1]) return { rowCount: 0 };
            row.rev += 1;
            row.system_prompt = params[2];
            row.config = params[9];
            const personaIdx = sql.match(/persona = \$(\d+)::jsonb/);
            if (personaIdx) {
                const raw = params[Number(personaIdx[1]) - 1];
                row.persona = raw === null ? null : JSON.parse(raw);
            }
            return { rowCount: 1 };
        }
        return { rowCount: 0, rows: [] };
    },
};

// The persona projection, delegating to the REAL module — with a switch, so
// "the projection is unavailable" is a state the tests can actually reach.
//
// Loaded by ABSOLUTE path on purpose. This file sits in the same directory as
// agentCrud.js, and Node memoises relative resolutions per (parent directory,
// request string): requiring it as '../../core/…' from here would seed that
// cache and agentCrud's own lazy require would then bypass
// Module._resolveFilename entirely — the mock silently never installs.
const realPersonaPrompt = require(require('node:path').join(__dirname, '..', '..', 'core', 'agentRuntime', 'personaPrompt'));
let personaProjectionBroken = false;
const mockPersonaPrompt = {
    ...realPersonaPrompt,
    personaOf(row) {
        if (personaProjectionBroken) throw new Error('personaPrompt is unreachable');
        return realPersonaPrompt.personaOf(row);
    },
};

const MOCKS = {
    '../../db': mockDb,
    '../../core/agentRuntime/personaPrompt': mockPersonaPrompt,
    './initSchema': { initDB: async () => {} },
    '../versionStore': {
        async createVersion(...args) { versionCalls.push(args); return { id: 'ver-1', version_number: 7, kind: args[5]?.kind || 'autosave' }; },
    },
    './agentTools': {
        getAgentTools: async () => [],
        getAgentToolsWithParams: async () => [],
        getAgentToolsBatch: async (ids) => new Map(ids.map(id => [id, []])),
        getAgentToolsWithParamsBatch: async (ids) => new Map(ids.map(id => [id, []])),
    },
};
const MOCK_IDS = {};
for (const [request, exportsObj] of Object.entries(MOCKS)) {
    const mockId = `mock:agentcrud-persona:${request}`;
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

test.beforeEach(() => { table.clear(); runs.length = 0; versionCalls.length = 0; personaProjectionBroken = false; });
test.after(() => { Module._resolveFilename = originalResolve; });

const FIELDS_PERSONA = {
    who: 'You are the Acme concierge.',
    does: ['Book meeting rooms'],
    unknown: { mode: 'honest', automationId: null },
    mode: 'fields',
};

// ── Who sees a persona ──────────────────────────────────────────────

test('getAgent carries the persona; getForRuntime does not', async () => {
    seed('a1', { persona: FIELDS_PERSONA });

    const draft = await agentCrud.getAgent('a1');
    assert.strictEqual(draft.persona.who, 'You are the Acme concierge.');
    assert.strictEqual(draft.persona.mode, 'fields');

    const runtime = await agentCrud.getForRuntime('a1');
    assert.ok(!('persona' in runtime),
        'the runtime reads the GENERATED prompt; a persona there is a second description nobody checked');
});

test('a NULL persona column reads back as free mode over the concept prompt', async () => {
    // The whole "migration" for every agent that predates the column — computed
    // on read, so no pass ever rewrites a live row.
    seed('a1', { persona: null, system_prompt: 'You answer questions about invoices.' });
    const draft = await agentCrud.getAgent('a1');
    assert.strictEqual(draft.persona.mode, 'free');
    assert.strictEqual(draft.persona.freeText, 'You answer questions about invoices.');
});

test('getAgentViews puts the persona on the DRAFT only', async () => {
    seed('a1', {
        persona: FIELDS_PERSONA,
        published_version: 2, published_rev: 1,
        published_config: { knowledge_base_ids: [] }, published_system_prompt: 'the published prompt',
    });
    const views = await agentCrud.getAgentViews('a1');
    assert.strictEqual(views.draft.persona.who, 'You are the Acme concierge.');
    assert.ok(!('persona' in views.runtime),
        'the concept persona describes the concept prompt — pairing it with the published one is a claim nobody made');
    assert.strictEqual(views.runtime.system_prompt, 'the published prompt');
});

test('the raw column never rides along on a list read', async () => {
    seed('a1', { persona: FIELDS_PERSONA });
    seed('a2', { persona: FIELDS_PERSONA });

    for (const a of await agentCrud.getAgents('owner')) {
        assert.ok(!('persona' in a), 'the library serves what runs, and a persona is not part of it');
    }
    for (const a of await agentCrud.getPublishedAgentsForUser([], null, new Set())) {
        assert.ok(!('persona' in a), 'anyone who can see a published agent would otherwise get its editor fields');
    }
});

// ── The write ───────────────────────────────────────────────────────

test('updateAgent without a persona option leaves the column untouched', async () => {
    seed('a1', { persona: FIELDS_PERSONA });
    const res = await agentCrud.updateAgent('a1', 'n', 'd', 'sp', 'owner', null, [], null, true, true, false, {}, false, null, undefined, undefined, {});
    assert.strictEqual(res.ok, true);
    assert.deepStrictEqual(table.get('a1').persona, FIELDS_PERSONA);
    assert.ok(!/persona/.test(runs.find(r => /^UPDATE agents SET name=/.test(r.sql)).sql),
        'no clause at all — a caller that never heard of personas cannot erase one');
});

test('updateAgent writes a supplied persona, and an explicit null clears it', async () => {
    seed('a1');
    await agentCrud.updateAgent('a1', 'n', 'd', 'sp', 'owner', null, [], null, true, true, false, {}, false, null, undefined, undefined, { persona: FIELDS_PERSONA });
    assert.deepStrictEqual(table.get('a1').persona, FIELDS_PERSONA);

    await agentCrud.updateAgent('a1', 'n', 'd', 'sp', 'owner', null, [], null, true, true, false, {}, false, null, undefined, undefined, { persona: null });
    assert.strictEqual(table.get('a1').persona, null);
});

test('the persona clause never disturbs the placeholder numbers the CAS guard uses', async () => {
    seed('a1', { rev: 7 });
    const ok = await agentCrud.updateAgent('a1', 'n', 'd', 'sp', 'owner', null, [], null, true, true, false, {}, false, null, undefined, undefined, { expectedRev: 7, persona: FIELDS_PERSONA });
    assert.strictEqual(ok.ok, true);
    const stmt = runs.find(r => /^UPDATE agents SET name=/.test(r.sql));
    assert.match(stmt.sql, /WHERE id=\$15 AND owner_id=\$16 AND rev = \$17/);
    assert.match(stmt.sql, /persona = \$18::jsonb/);

    const stale = await agentCrud.updateAgent('a1', 'n', 'd', 'sp', 'owner', null, [], null, true, true, false, {}, false, null, undefined, undefined, { expectedRev: 7, persona: FIELDS_PERSONA });
    assert.strictEqual(stale.conflict, true, 'the CAS token still bites with a persona clause in the SET list');
});

test('createAgent stores the persona it is given, and NULL when it is given none', async () => {
    const withPersona = await agentCrud.createAgent('n', 'd', 'sp', 'owner', null, [], true, true, false, {}, null, [], null, { persona: FIELDS_PERSONA });
    assert.deepStrictEqual(table.get(withPersona.id).persona, FIELDS_PERSONA);

    const without = await agentCrud.createAgent('n', 'd', 'sp', 'owner');
    assert.strictEqual(table.get(without.id).persona, null,
        'a caller that knows nothing about personas creates exactly what it always created');
});

test('when the projection is unavailable the key is OMITTED, never set to null', async () => {
    // A client re-syncs from this payload and sends it back. A `persona: null`
    // born from a FAILED READ would return as an explicit "clear the column"
    // and delete a role nobody touched — the read becoming a decision.
    seed('a1', { persona: FIELDS_PERSONA });
    personaProjectionBroken = true;

    const draft = await agentCrud.getAgent('a1');
    assert.ok(!('persona' in draft), 'a missing key means preserve, all the way down to the SET list');

    const views = await agentCrud.getAgentViews('a1');
    assert.ok(!('persona' in views.draft));
    assert.strictEqual(views.draft.name, 'seed', 'and the rest of the agent still loads');
});

// ── snapshotAgent: het undo-punt van een verfijning ─────────────────

test('snapshotAgent snapshot de RAUWE rij, niet de weergave van getAgent', async () => {
    seed('a1', { persona: FIELDS_PERSONA, config: JSON.stringify({ memoryEnabled: true }) });

    const created = await agentCrud.snapshotAgent('a1', 'u1', { kind: 'pre_refine' });
    assert.deepStrictEqual(created, { id: 'ver-1', version_number: 7, kind: 'pre_refine' });

    assert.strictEqual(versionCalls.length, 1);
    const [agentId, agentType, snapshot, userId, summary, opts] = versionCalls[0];
    assert.strictEqual(agentId, 'a1');
    assert.strictEqual(agentType, 'agent');
    assert.strictEqual(userId, 'u1');
    assert.strictEqual(opts.kind, 'pre_refine');
    assert.strictEqual(typeof summary, 'string', 'een eigen samenvatting, zodat createVersion er geen hoeft te verzinnen');
    // De rauwe vorm: config als JSON-tekst, persona als de kolom zelf.
    assert.strictEqual(snapshot.config, JSON.stringify({ memoryEnabled: true }));
    assert.strictEqual(snapshot.owner_id, 'owner', 'restore schrijft met deze owner_id — die moet erin zitten');
});

test('een kapotte persona-projectie maakt de snapshot niet persona-loos', async () => {
    // Dit is de reden dat snapshotAgent NIET via getAgent() leest: daar valt
    // `persona` bij een leesfout helemaal weg (_withPersona laat de sleutel
    // dan weg), en de restore leest zo'n ontbrekende sleutel als null en
    // schrijft de kolom leeg. De rauwe rij draagt hem hoe dan ook.
    seed('a1', { persona: FIELDS_PERSONA });
    personaProjectionBroken = true;

    const view = await agentCrud.getAgent('a1');
    assert.ok(!('persona' in view), 'de weergave laat hem inderdaad weg — dat is het gevaar');

    await agentCrud.snapshotAgent('a1', 'u1', { kind: 'pre_refine' });
    const snapshot = versionCalls[0][2];
    assert.deepStrictEqual(snapshot.persona, FIELDS_PERSONA, 'de snapshot houdt de rol vast');
});

test('snapshotAgent van een onbekende agent geeft null en schrijft geen versie', async () => {
    const created = await agentCrud.snapshotAgent('nope', 'u1', { kind: 'pre_refine' });
    assert.strictEqual(created, null, '"niets te herstellen" is iets anders dan "een snapshot van niets"');
    assert.strictEqual(versionCalls.length, 0);
});
