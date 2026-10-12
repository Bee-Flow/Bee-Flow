/**
 * Validator rules for an `ai_step` that hands its thinking to an AGENT (R2).
 *
 * The three that are safety rather than tidiness:
 *
 *   - EVERY way of not being allowed to use an agent gives the SAME answer.
 *     A deleted id, an id from another organisation, an unpublished agent and
 *     one that is simply not shared all produce one code, one severity, one
 *     path and one message. Anything less and the automation editor is an
 *     existence oracle for every other workspace on the install: type an id,
 *     read off the error whether it is real somewhere.
 *
 *   - MISSING `agentPermissions` means NONE. The grants map in
 *     core/agentRuntime/toolPolicy.js does read a missing app entry as "every
 *     action of this app", and that is right there — those agents had that
 *     toolbelt before the picker existed. This surface has no such yesterday,
 *     so the exception has nothing to stand on.
 *
 *   - the identity rule runs at SAVE and at ACTIVATE, and the run happens
 *     later. So it is completeness-listed (an automation whose agent vanished
 *     stays openable and fixable, and cannot go live), and the real gate is
 *     `resolveStepAgent` in core/automationRunner/aiStepAgent.js, which FAILS
 *     the step rather than running it without the agent it names. The last
 *     block below holds those two halves to the same answer.
 *
 * Run: cd server && node --test automation/validate.agentStep.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert');

const { validateDefinition } = require('./validate');
const { COMPLETENESS_CODES } = require('./validate/completenessCodes');
const { AI_STEP_AGENT_PERMISSION_KEYS, MAX_AI_STEP_SKILL_IDS } = require('./validate/constants');
const { mayAutomationUseAgent, collectAgentIds, agentCatalogFor, servesPublishedConfig } = require('./agentCatalog');

const TRIGGER = { id: 'trg', kind: 'manual' };
const OFF = { startAutomations: false, useKnowledge: false, useTools: false };

function def(step, extra = {}) {
    return {
        trigger: TRIGGER,
        steps: [{ id: 's1', type: 'ai_step', prompt: 'do the thing', ...step }],
        edges: [{ from: 'trg', to: 's1' }],
        ...extra,
    };
}
const run = (definition, stage, opts = {}) => validateDefinition(definition, { ...(stage ? { stage } : {}), ...opts });
const errorCodes = (d, stage, opts) => (run(d, stage, opts).errors || []).map(e => e.code);
const warnCodes = (d, stage, opts) => (run(d, stage, opts).warnings || []).map(e => e.code);

// ── the happy shape ─────────────────────────────────────────────────────────

test('a fully configured agent step validates at every stage', () => {
    const d = def({ agentId: 'agt_1', skillIds: ['sk_a'], agentPermissions: OFF });
    for (const stage of ['draft', 'activate']) {
        assert.deepStrictEqual(errorCodes(d, stage), [], stage);
        assert.deepStrictEqual(warnCodes(d, stage), [], stage);
    }
});

test('a plain ai_step is untouched by any of this', () => {
    const d = def({});
    assert.deepStrictEqual(errorCodes(d, 'activate'), []);
    assert.deepStrictEqual(warnCodes(d, 'activate'), []);
});

// ── one answer for every way of not being allowed ───────────────────────────

test('an agent outside the catalog is refused, and the refusal says nothing about why', () => {
    const catalog = new Set(['agt_mine']);
    const rec = run(def({ agentId: 'agt_elsewhere', agentPermissions: OFF }), 'activate', { availableAgents: catalog }).errors[0];
    assert.strictEqual(rec.code, 'ai_step.agent_unavailable');
    assert.strictEqual(rec.path, 'steps[s1].agentId', 'the marker lands on the step, on the field');
    // The message may echo the id the author typed; it must not say which of
    // the four states the agent is in.
    assert.doesNotMatch(rec.message, /organisation|organization|workspace|publish|deleted|shared/i);
    // The hint names all four, which is exactly what tells the reader nothing.
    for (const word of [/deleted/i, /never published/i, /another workspace/i, /not shared/i]) {
        assert.match(rec.hint, word);
    }
});

test('"belongs to someone else" and "does not exist" are the SAME record', () => {
    // The whole rule, in one assertion: if these two ever differ, an automation
    // editor becomes a way to enumerate other workspaces' agents.
    const catalog = new Set(['agt_mine']);
    const only = (id) => {
        const r = run(def({ agentId: id, agentPermissions: OFF }), 'activate', { availableAgents: catalog });
        return [...r.errors, ...r.warnings].map(({ code, severity, path, message, hint }) =>
            ({ code, severity, path, message: message.replace(id, '<id>'), hint }));
    };
    assert.deepStrictEqual(only('agt_in_other_org'), only('agt_never_existed'));
});

test('no catalog means no identity check — the pure pass stays pure', () => {
    // Same construction as availableTools: without a catalog this validator
    // cannot answer a database question, and inventing one either way is worse
    // than the run-time check it leans on.
    assert.deepStrictEqual(errorCodes(def({ agentId: 'agt_x', agentPermissions: OFF }), 'activate'), []);
});

test('an agent that vanished blocks ACTIVATION but never a save', () => {
    // The automation has to stay openable and fixable — an import arrives with an
    // id from wherever it was built, and an agent can be deleted the day after
    // the automation was written.
    const d = def({ agentId: 'agt_gone', agentPermissions: OFF });
    const opts = { availableAgents: new Set() };
    assert.deepStrictEqual(errorCodes(d, 'draft', opts), [], 'a stranded automation must stay saveable');
    assert.ok(warnCodes(d, 'draft', opts).includes('ai_step.agent_unavailable'));
    assert.deepStrictEqual(errorCodes(d, 'activate', opts), ['ai_step.agent_unavailable']);
    assert.ok(COMPLETENESS_CODES.has('ai_step.agent_unavailable'), 'the ladder is not an accident');
});

test('an agentId that is not a string is wrong rather than unfinished — it blocks at draft too', () => {
    for (const bad of [7, {}, ['agt_1'], true]) {
        assert.deepStrictEqual(errorCodes(def({ agentId: bad }), 'draft'), ['ai_step.agent_id_invalid'], JSON.stringify(bad));
    }
    assert.ok(!COMPLETENESS_CODES.has('ai_step.agent_id_invalid'));
});

test('the identity check is skipped for a malformed id — one complaint per node', () => {
    const codes = errorCodes(def({ agentId: 42 }), 'activate', { availableAgents: new Set() });
    assert.deepStrictEqual(codes, ['ai_step.agent_id_invalid']);
});

// ── agentPermissions: absent means none ─────────────────────────────────────

test('an agent step with NO permissions is told what that means, and still saves', () => {
    const d = def({ agentId: 'agt_1' });
    assert.deepStrictEqual(errorCodes(d, 'activate'), []);
    const rec = run(d, 'activate').warnings.find(w => w.code === 'ai_step.agent_permissions_missing');
    assert.ok(rec, 'the default is stated rather than assumed');
    assert.match(rec.message, /no knowledge bases, no tools/i);
    assert.match(rec.message, /cannot start other automations/i);
});

test('an unreadable permissions object blocks activation but stays saveable', () => {
    for (const bad of ['all', 42, ['useTools'], true]) {
        const d = def({ agentId: 'agt_1', agentPermissions: bad });
        assert.deepStrictEqual(errorCodes(d, 'draft'), [], JSON.stringify(bad));
        assert.deepStrictEqual(errorCodes(d, 'activate'), ['ai_step.agent_permissions_invalid'], JSON.stringify(bad));
    }
    assert.ok(COMPLETENESS_CODES.has('ai_step.agent_permissions_invalid'));
});

test('a permission whose value nobody can read is refused, never coerced', () => {
    // `"false"` is truthy. Coercing it is the widest possible answer to the
    // least readable input, which is the one thing this layer keeps getting
    // wrong — so it is reported instead.
    for (const v of ['false', 'true', 1, 0, null]) {
        const codes = errorCodes(def({ agentId: 'agt_1', agentPermissions: { ...OFF, useTools: v } }), 'activate');
        assert.deepStrictEqual(codes, ['ai_step.agent_permissions_invalid'], JSON.stringify(v));
    }
});

test('a permission this step does not grant is reported as inert, not stored in silence', () => {
    const d = def({ agentId: 'agt_1', agentPermissions: { ...OFF, useEverything: true } });
    const rec = run(d, 'activate').warnings.find(w => w.code === 'ai_step.agent_permissions_unknown');
    assert.ok(rec);
    assert.match(rec.message, /stored and does nothing/);
    assert.deepStrictEqual(errorCodes(d, 'activate'), [], 'inert, so it does not block');
});

test('permissions without an agent configure nothing, and say so', () => {
    const d = def({ agentPermissions: { ...OFF, useTools: true } });
    assert.ok(warnCodes(d, 'activate').includes('ai_step.agent_permissions_orphan'));
    assert.deepStrictEqual(errorCodes(d, 'activate'), []);
});

// ── skills ──────────────────────────────────────────────────────────────────

test('skillIds must be a list of ids, at every stage', () => {
    for (const bad of ['sk_a', 7, { 0: 'sk_a' }, ['sk_a', 5]]) {
        assert.deepStrictEqual(errorCodes(def({ skillIds: bad }), 'draft'), ['ai_step.skill_ids_invalid'], JSON.stringify(bad));
    }
});

test('skills past the cap are named, not silently dropped at run time', () => {
    const many = Array.from({ length: MAX_AI_STEP_SKILL_IDS + 2 }, (_, i) => `sk_${i}`);
    const rec = run(def({ skillIds: many }), 'activate').warnings.find(w => w.code === 'ai_step.skill_ids_ignored');
    assert.ok(rec);
    assert.match(rec.message, new RegExp(`"sk_${MAX_AI_STEP_SKILL_IDS}"`), 'it says WHICH skill never reaches the model');
    assert.deepStrictEqual(errorCodes(def({ skillIds: many }), 'activate'), [], 'a warning, never a block');
});

test('a repeated skill is reported — the first entry decides the order', () => {
    const rec = run(def({ skillIds: ['sk_a', 'sk_b', 'sk_a'] }), 'activate').warnings
        .find(w => w.code === 'ai_step.skill_ids_ignored');
    assert.ok(rec);
    assert.match(rec.message, /"sk_a"/);
});

test('skills need no agent — applying a skill to a plain step is its own thing', () => {
    const d = def({ skillIds: ['sk_a'] });
    assert.deepStrictEqual(errorCodes(d, 'activate'), []);
    assert.deepStrictEqual(warnCodes(d, 'activate'), []);
});

// ── nesting ─────────────────────────────────────────────────────────────────

test('the rules reach a step inside a loop body', () => {
    const d = {
        trigger: TRIGGER,
        steps: [{
            id: 'l1', type: 'loop', overRef: 'trigger.output.rows', itemVar: 'row',
            body: [{ id: 'b1', type: 'ai_step', prompt: 'p', agentId: 'agt_gone', agentPermissions: OFF }],
        }],
        edges: [{ from: 'trg', to: 'l1' }],
    };
    assert.ok(errorCodes(d, 'activate', { availableAgents: new Set() }).includes('ai_step.agent_unavailable'));
});

// ── the catalog builder ─────────────────────────────────────────────────────

test('the catalog looks up only the agents the definition names — including nested ones', () => {
    const d = {
        trigger: TRIGGER,
        steps: [
            { id: 's1', type: 'ai_step', prompt: 'p', agentId: ' agt_a ' },
            { id: 'l1', type: 'loop', body: [{ id: 'b1', type: 'ai_step', prompt: 'p', agentId: 'agt_b' }] },
            { id: 'p1', type: 'parallel', branches: [[{ id: 'c1', type: 'ai_step', prompt: 'p', agentId: 'agt_a' }]] },
            { id: 's2', type: 'ai_step', prompt: 'p' },
        ],
        edges: [],
        layers: { enrich: { steps: [{ id: 'x1', type: 'ai_step', prompt: 'p', agentId: 'agt_c' }] } },
    };
    assert.deepStrictEqual(collectAgentIds(d).sort(), ['agt_a', 'agt_b', 'agt_c']);
});

test('an automation with no agent step gets an EMPTY catalog, not "could not check"', () => {
    // The difference matters: null turns the rule off, and "there was nothing
    // to look up" is not "the lookup failed".
    return agentCatalogFor(def({}), { userId: 'u1' }).then((set) => {
        assert.ok(set instanceof Set);
        assert.strictEqual(set.size, 0);
    });
});

test('a lookup that fails yields NO catalog — never a partial one', () => {
    // A partial Set would report an agent we could not check as unavailable,
    // which is a wrong answer to an outage rather than a cautious one.
    const agentStore = {
        getForRuntime: async (id) => {
            if (id === 'agt_b') throw new Error('database is down');
            return { id, owner_id: 'u1', is_published: true, organization_id: null, shared_groups: [] };
        },
    };
    const d = {
        trigger: TRIGGER,
        steps: [
            { id: 's1', type: 'ai_step', prompt: 'p', agentId: 'agt_a' },
            { id: 's2', type: 'ai_step', prompt: 'p', agentId: 'agt_b' },
        ],
        edges: [],
    };
    return agentCatalogFor(d, { userId: 'u1', deps: { agentStore } })
        .then((set) => assert.strictEqual(set, null));
});

test('the catalog holds only the agents this automation may use', () => {
    const rows = {
        agt_mine: { id: 'agt_mine', owner_id: 'u1', is_published: false, organization_id: 'org1', shared_groups: [] },
        agt_org: { id: 'agt_org', owner_id: 'u2', is_published: true, published_version: 2, organization_id: 'org1', shared_groups: [] },
        agt_other_org: { id: 'agt_other_org', owner_id: 'u3', is_published: true, published_version: 2, organization_id: 'org2', shared_groups: [] },
        agt_draft: { id: 'agt_draft', owner_id: 'u2', is_published: false, organization_id: 'org1', shared_groups: [] },
        // Shared but never versioned: the library switch is on, no version was
        // ever published, so `getForRuntime` still serves the owner's LIVE
        // draft. Not an automation's to run — see servesPublishedConfig.
        agt_shared_unversioned: { id: 'agt_shared_unversioned', owner_id: 'u2', is_published: true, published_version: 0, organization_id: 'org1', shared_groups: [] },
    };
    const agentStore = { getForRuntime: async (id) => rows[id] || null };
    const d = {
        trigger: TRIGGER,
        steps: Object.keys(rows).concat(['agt_missing']).map((id, i) =>
            ({ id: `s${i}`, type: 'ai_step', prompt: 'p', agentId: id })),
        edges: [],
    };
    return agentCatalogFor(d, { userId: 'u1', orgId: 'org1', groups: [], deps: { agentStore } })
        .then((set) => assert.deepStrictEqual([...set].sort(), ['agt_mine', 'agt_org']));
});

// ── the two halves of one rule ──────────────────────────────────────────────

test('the cap this validator warns about is the cap the runtime truncates at', () => {
    // A drift here means an author is told their fifth skill is fine while
    // mergeSkillIds has already cut it, or the other way round.
    const { SKILL_CAP } = require('../core/tools/skillInjection');
    assert.strictEqual(MAX_AI_STEP_SKILL_IDS, SKILL_CAP);
});

test('the permission names are the ones the runtime reads', () => {
    const { AGENT_PERMISSION_KEYS } = require('../core/automationRunner/aiStepAgent');
    assert.deepStrictEqual([...AI_STEP_AGENT_PERMISSION_KEYS], [...AGENT_PERMISSION_KEYS]);
});

test('save-time and run-time agree on WHICH agents an automation may use', () => {
    // Two implementations of one rule — agentCatalog.mayAutomationUseAgent at save
    // and aiStepAgent's own predicate at run time. They cannot be one function
    // (one takes a request-shaped principal, the other a run context), so they
    // are held to the same table instead. A disagreement here is either a
    // automation that activates and then fails every night, or one that is refused
    // for an agent it could have used.
    const { resolveStepAgent } = require('../core/automationRunner/aiStepAgent');
    const base = { id: 'agt_1', name: 'A', config: {}, system_prompt: '' };
    // `published_version` is part of the row on purpose: "shared" and "serving
    // a published config" are two switches, and only the second one decides
    // what actually runs (stores/agent/agentCrud.js: isSplitActive). The
    // EXPECTED column is checked as well as the agreement — two functions that
    // agree on the wrong answer are still the wrong answer.
    const pub = { is_published: true, published_version: 2 };
    const cases = [
        ['owner, never published', { owner_id: 'u1', is_published: false, organization_id: 'org1', shared_groups: [] }, { userId: 'u1', orgId: 'org1', groups: [] }, true],
        ['published, same org', { owner_id: 'u2', ...pub, organization_id: 'org1', shared_groups: [] }, { userId: 'u1', orgId: 'org1', groups: [] }, true],
        ['published, other org', { owner_id: 'u2', ...pub, organization_id: 'org2', shared_groups: [] }, { userId: 'u1', orgId: 'org1', groups: [] }, false],
        ['published, no org, asker in an org', { owner_id: 'u2', ...pub, organization_id: null, shared_groups: [] }, { userId: 'u1', orgId: 'org1', groups: [] }, false],
        ['published org agent, asker without an org', { owner_id: 'u2', ...pub, organization_id: 'org1', shared_groups: [] }, { userId: 'u1', orgId: null, groups: [] }, false],
        ['published global, asker without an org', { owner_id: 'u2', ...pub, organization_id: null, shared_groups: [] }, { userId: 'u1', orgId: null, groups: [] }, true],
        ['shared with a group the asker is in', { owner_id: 'u2', ...pub, organization_id: 'org1', shared_groups: ['g1'] }, { userId: 'u1', orgId: 'org1', groups: ['g1'] }, true],
        ['shared with a group the asker is not in', { owner_id: 'u2', ...pub, organization_id: 'org1', shared_groups: ['g1'] }, { userId: 'u1', orgId: 'org1', groups: ['g2'] }, false],
        ['not published, someone else\'s', { owner_id: 'u2', is_published: false, organization_id: 'org1', shared_groups: [] }, { userId: 'u1', orgId: 'org1', groups: [] }, false],
        // The split: the library switch is on, no version was ever published.
        ['shared, but no version ever published', { owner_id: 'u2', is_published: true, published_version: 0, organization_id: 'org1', shared_groups: [] }, { userId: 'u1', orgId: 'org1', groups: [] }, false],
        ['shared, runtime says it is serving the live draft', { owner_id: 'u2', is_published: true, runtimeSource: 'live', organization_id: 'org1', shared_groups: [] }, { userId: 'u1', orgId: 'org1', groups: [] }, false],
        ['my OWN unversioned agent stays mine to use', { owner_id: 'u1', is_published: true, published_version: 0, organization_id: 'org1', shared_groups: [] }, { userId: 'u1', orgId: 'org1', groups: [] }, true],
    ];
    const step = { id: 's1', type: 'ai_step', agentId: 'agt_1' };
    return Promise.all(cases.map(async ([label, row, principal, expected]) => {
        const agent = { ...base, ...row };
        const saveTime = mayAutomationUseAgent(agent, principal);
        const ctx = { userId: principal.userId, orgId: principal.orgId, userGroupIds: principal.groups };
        let runTime = true;
        try {
            await resolveStepAgent(step, ctx, { agentStore: { getForRuntime: async () => agent } });
        } catch (_) { runTime = false; }
        assert.strictEqual(saveTime, runTime, `${label}: save says ${saveTime}, run says ${runTime}`);
        assert.strictEqual(saveTime, expected, `${label}: expected ${expected}, both said ${saveTime}`);
    }));
});

test('shared is not published: only a serving VERSION opens the door for someone else', () => {
    // `is_published` is the LIBRARY switch (setAgentPublished); which config
    // runs is decided by `published_version > 0` (isSplitActive). They move
    // independently — publishing to the library never touches the version, and
    // the backfill deliberately does not run at boot — so `is_published: true`
    // with `published_version: 0` is an ordinary state in which getForRuntime
    // serves the owner's LIVE draft. Someone else's unattended automation running
    // on that draft means every autosave in the agent editor changes what fires
    // tonight, with no version and no review.
    assert.strictEqual(servesPublishedConfig({ is_published: true, published_version: 3 }), true);
    assert.strictEqual(servesPublishedConfig({ is_published: true, published_version: 0 }), false);
    assert.strictEqual(servesPublishedConfig({ is_published: true }), false, 'no evidence of a publication narrows');
    // `runtimeSource` is the answer getForRuntime hands out itself, and it wins
    // over the column when it is there.
    assert.strictEqual(servesPublishedConfig({ runtimeSource: 'published', published_version: 0 }), true);
    assert.strictEqual(servesPublishedConfig({ runtimeSource: 'live', published_version: 9 }), false);
});

test('an identity that could not be read is not a yes', () => {
    // `orgId`, `orgRole` and the group list come out of ONE read in
    // execution.js, so `identityError` means the org question and the group
    // question are both unanswered. The datatable step already refuses on it;
    // this gate is the same question about the same person. The owner's own
    // agent is unaffected — `owner_id` equality needs no identity read.
    const { resolveStepAgent } = require('../core/automationRunner/aiStepAgent');
    const step = { id: 's1', type: 'ai_step', agentId: 'agt_1' };
    const shared = { id: 'agt_1', owner_id: 'u2', is_published: true, published_version: 1, organization_id: 'org1', shared_groups: [], config: {}, system_prompt: '' };
    const mine = { ...shared, owner_id: 'u1' };
    const ctx = { userId: 'u1', orgId: 'org1', userHomeOrgId: 'org1', userGroupIds: [], identityError: 'users table unreachable' };
    return Promise.all([
        assert.rejects(
            () => resolveStepAgent(step, ctx, { agentStore: { getForRuntime: async () => shared } }),
            (e) => e.errorClass === 'agent_unavailable',
        ),
        resolveStepAgent(step, ctx, { agentStore: { getForRuntime: async () => mine } })
            .then((b) => assert.strictEqual(b.agentId, 'agt_1')),
    ]);
});

test('the org boundary is the owner\'s membership, not the stamp on the automation row', () => {
    // `ctx.orgId` is runOrgFor(automation, session) — the automations column,
    // which does NOT move when an admin transfers the owner to another
    // organisation. `ctx.userHomeOrgId` is read fresh from `users` in the same
    // place `orgRole` is. An automation stamped org1 whose owner now lives in org2
    // must resolve org2's agents, or it keeps running on his old workspace's
    // toolgrants and knowledge bases forever.
    const { resolveStepAgent } = require('../core/automationRunner/aiStepAgent');
    const step = { id: 's1', type: 'ai_step', agentId: 'agt_1' };
    const agentIn = (org) => ({ id: 'agt_1', owner_id: 'u2', is_published: true, published_version: 1, organization_id: org, shared_groups: [], config: {}, system_prompt: '' });
    const ctx = { userId: 'u1', orgId: 'org1', userHomeOrgId: 'org2', userGroupIds: [], identityError: null };
    return Promise.all([
        resolveStepAgent(step, ctx, { agentStore: { getForRuntime: async () => agentIn('org2') } })
            .then((b) => assert.strictEqual(b.agentId, 'agt_1', 'the owner\'s CURRENT org decides')),
        assert.rejects(
            () => resolveStepAgent(step, ctx, { agentStore: { getForRuntime: async () => agentIn('org1') } }),
            (e) => e.errorClass === 'agent_unavailable',
            'the stale stamp on the automation row does not open a door',
        ),
    ]);
});

test('the run refuses an agent it cannot use rather than running the step without one', () => {
    // The half no validation can cover: the agent is deleted the day after the
    // automation went live. Running the step bare would look, from outside, like a
    // successful run with a thin answer.
    const { resolveStepAgent } = require('../core/automationRunner/aiStepAgent');
    const step = { id: 's1', type: 'ai_step', agentId: 'agt_gone' };
    const ctx = { userId: 'u1', orgId: 'org1', userGroupIds: [] };
    return assert.rejects(
        () => resolveStepAgent(step, ctx, { agentStore: { getForRuntime: async () => null } }),
        (e) => e.errorClass === 'agent_unavailable',
    );
});
