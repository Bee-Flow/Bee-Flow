/**
 * projects/relatedParts.js — what else comes along when a part is added.
 *
 * Pinned here:
 *   1. the walk is TRANSITIVE and lists dependencies before what needs them;
 *   2. every relation code, and the table verb (reads / writes);
 *   3. the statuses, and that a part that is not the caller's is never read;
 *   4. a cycle ends, the cap is reported, a selected part is not "related";
 *   5. every edge graph.js draws for a part is found by this walk too.
 *
 * Every data source is an injected double (the `d` argument): no module mocking.
 *
 * Run: cd server && node --test projects/relatedParts.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { findRelatedParts, edgesOf, MAX_RELATED, RELATION, STATUS } = require('./relatedParts');
const { buildProjectGraph } = require('./graph');

const ME = 'alice';
const PROJECT = { id: 'sol1', kind: 'solution', knowledgeBaseIds: ['kbHere'], organizationId: 'org1' };

/** world: 'kind:id' → { owner, project?, name, payload? } */
function doubles(world, { attachable = [], seeAs = {} } = {}) {
    const reads = [];
    const at = (kind, id) => world[`${kind}:${id}`];
    return {
        reads,
        d: {
            ownerOf: async (kind, id) => at(kind, id)?.owner ?? null,
            projectOf: async (kind, id) => at(kind, id)?.project ?? null,
            readPart: async (kind, id) => {
                reads.push(`${kind}:${id}`);
                const w = at(kind, id);
                return w ? { name: w.name, payload: w.payload ?? null } : null;
            },
            canAttachKnowledgeBase: async (_req, id) => attachable.includes(id),
            visibleProjectName: async (_user, projectId) => seeAs[projectId] ?? null,
        },
    };
}

const run = (world, items, opts) => {
    const { d, reads } = doubles(world, opts);
    return findRelatedParts({ project: PROJECT, userId: ME, req: {}, items }, d).then((r) => ({ ...r, reads }));
};
const mine = (name, payload, extra = {}) => ({ owner: ME, name, payload, ...extra });
const def = (...steps) => ({ definition: { steps } });
const byId = (res, id) => res.related.find((p) => p.id === id);

test('an app drags in its automation, that automation\'s block, tables, template, skill and base', async () => {
    const world = {
        'app:app1': mine('Intake app', { definition: { actions: [{ id: 'go', kind: 'run_automation', automationId: 'a1' }] } }),
        'automation:a1': mine('Intake automation', def(
            { id: 's1', type: 'call_block', blockId: 'blk' },
            { id: 's2', type: 'datatable', op: 'list', datatableId: 'tRead' },
            { id: 's3', type: 'datatable', op: 'add_row', datatableId: 'tWrite', values: {} },
            { id: 's4', type: 'fill_document', documentId: 'tpl' },
            { id: 's5', type: 'ai_step', skillIds: ['sk'], knowledgeBaseIds: ['kb1'], agentId: 'ag' },
        )),
        'automation:blk': mine('Shared step', { definition: { steps: [] } }),
        'datatable:tRead': mine('Leads'),
        'datatable:tWrite': mine('Outbox'),
        'document_template:tpl': mine('Letter'),
        'skill:sk': mine('Tone', { knowledge_base_ids: ['kb2'] }),
        'knowledge_base:kb1': { name: 'Handbook' },
        'knowledge_base:kb2': { name: 'Policies' },
        'agent:ag': mine('Helper', { config: { knowledge_base_ids: ['kb1'] } }),
    };
    const res = await run(world, [{ kind: 'app', id: 'app1' }], { attachable: ['kb1', 'kb2'] });

    assert.strictEqual(res.truncated, false);
    assert.deepStrictEqual(res.related.map((p) => `${p.kind}:${p.id}`).sort(), [
        'agent:ag', 'automation:a1', 'automation:blk', 'datatable:tRead', 'datatable:tWrite',
        'document_template:tpl', 'knowledge_base:kb1', 'knowledge_base:kb2', 'skill:sk',
    ]);
    assert.strictEqual(byId(res, 'a1').relation, RELATION.RUNS);
    assert.deepStrictEqual(byId(res, 'a1').via, [{ kind: 'app', id: 'app1', name: 'Intake app', relation: 'runs' }]);
    assert.strictEqual(byId(res, 'blk').relation, RELATION.CALLS);
    assert.strictEqual(byId(res, 'tRead').relation, RELATION.READS_TABLE);
    assert.strictEqual(byId(res, 'tWrite').relation, RELATION.WRITES_TABLE);
    assert.strictEqual(byId(res, 'tpl').relation, RELATION.USES_TEMPLATE);
    assert.strictEqual(byId(res, 'sk').relation, RELATION.USES_SKILL);
    assert.strictEqual(byId(res, 'ag').relation, RELATION.USES_AGENT);
    assert.strictEqual(byId(res, 'kb2').relation, RELATION.GROUNDS_ON_KB);
    assert.ok(res.related.every((p) => p.status === STATUS.ADDABLE));
    // Needed by two parts: both are named.
    assert.deepStrictEqual(byId(res, 'kb1').via.map((v) => v.id).sort(), ['a1', 'ag']);
});

test('dependencies come before whatever needs them', async () => {
    const world = {
        'app:app1': mine('App', { definition: { actions: [{ kind: 'run_automation', automationId: 'a1' }] } }),
        'automation:a1': mine('A', def({ id: 's', type: 'call_block', blockId: 'b1' })),
        'automation:b1': mine('B', def({ id: 't', type: 'datatable', op: 'list', datatableId: 't1' })),
        'datatable:t1': mine('T'),
    };
    const res = await run(world, [{ kind: 'app', id: 'app1' }]);
    assert.deepStrictEqual(res.related.map((p) => p.id), ['t1', 'b1', 'a1']);
});

test('a webpage grant runs an automation, and a page or app table binding uses a table', async () => {
    const world = {
        'webpage:w1': mine('Page', { bridgeGrants: { automations: [{ automationId: 'a1' }], tables: [{ datatableId: 't1' }], agent: { agentId: 'ag' } }, knowledgeBaseIds: ['kbHere'] }),
        'app:app1': mine('App', { definition: {}, dataModel: { tables: [{ key: 'x', source: { datatableId: 't2' } }] } }),
        'automation:a1': mine('A', { definition: { steps: [] } }),
        'datatable:t1': mine('T1'), 'datatable:t2': mine('T2'),
        'agent:ag': mine('Ag', { config: {} }),
        'knowledge_base:kbHere': { name: 'Here' },
    };
    const res = await run(world, [{ kind: 'webpage', id: 'w1' }, { kind: 'app', id: 'app1' }]);
    assert.strictEqual(byId(res, 'a1').relation, RELATION.RUNS);
    assert.strictEqual(byId(res, 't1').relation, RELATION.USES_TABLE);
    assert.strictEqual(byId(res, 't2').relation, RELATION.USES_TABLE);
    assert.strictEqual(byId(res, 'kbHere').status, STATUS.ALREADY_HERE);
});

test('a skill that runs an automation brings it, and a cache table counts as a write', () => {
    assert.deepStrictEqual(
        edgesOf('skill', { knowledge_base_ids: ['k'], allowed_automation_ids: ['a'], automation_id: 'b' }).map((e) => e.relation),
        [RELATION.GROUNDS_ON_KB, RELATION.SKILL_RUNS, RELATION.SKILL_RUNS],
    );
    const cache = edgesOf('automation', def({ id: 'h', type: 'http_request', cacheInto: { datatableId: 'c' } }));
    assert.deepStrictEqual(cache, [{ kind: 'datatable', id: 'c', relation: RELATION.WRITES_TABLE }]);
    const writes = edgesOf('automation', def({ id: 'k', type: 'knowledge_write', knowledgeBaseId: 'kbx' }));
    assert.strictEqual(writes[0].relation, RELATION.WRITES_KB);
});

test('statuses: here already, in another Solution (named only when visible), not yours, missing', async () => {
    const world = {
        'app:app1': mine('App', { definition: { actions: [
            { kind: 'run_automation', automationId: 'here' },
            { kind: 'run_automation', automationId: 'other' },
            { kind: 'run_automation', automationId: 'hidden' },
            { kind: 'run_automation', automationId: 'theirs' },
            { kind: 'run_automation', automationId: 'gone' },
        ] } }),
        'automation:here': mine('Here', { definition: { steps: [{ id: 's', type: 'datatable', op: 'list', datatableId: 'never' }] } }, { project: 'sol1' }),
        'automation:other': mine('Other', null, { project: 'sol2' }),
        'automation:hidden': mine('Hidden', null, { project: 'sol3' }),
        'automation:theirs': { owner: 'bob', name: 'Bob secret automation', payload: { definition: { steps: [{ id: 's', type: 'datatable', op: 'list', datatableId: 'bobTable' }] } } },
        'datatable:never': mine('Never'),
        'datatable:bobTable': mine('Bob table'),
    };
    const res = await run(world, [{ kind: 'app', id: 'app1' }], { seeAs: { sol2: 'Sales Desk' } });

    assert.strictEqual(byId(res, 'here').status, STATUS.ALREADY_HERE);
    assert.strictEqual(byId(res, 'other').status, STATUS.IN_OTHER_SOLUTION);
    assert.strictEqual(byId(res, 'other').solutionName, 'Sales Desk');
    assert.strictEqual(byId(res, 'hidden').solutionName, null);
    assert.strictEqual(byId(res, 'theirs').status, STATUS.NOT_YOURS);
    assert.strictEqual(byId(res, 'theirs').name, null, 'a stranger\'s part is not named');
    assert.strictEqual(byId(res, 'gone').status, STATUS.NOT_FOUND);
    assert.strictEqual(byId(res, 'never'), undefined, 'a part already here is not expanded');
    assert.strictEqual(byId(res, 'bobTable'), undefined, 'a part that is not the caller\'s is not expanded');
    assert.ok(!res.reads.includes('automation:theirs'), 'its definition was never read');
});

test('a knowledge base is addable only when the caller may read it', async () => {
    const world = {
        'agent:ag': mine('Ag', { config: { knowledge_base_ids: ['kbOk', 'kbNo', 'kbHere', 'kbGone'] } }),
        'knowledge_base:kbOk': { name: 'Ok' }, 'knowledge_base:kbNo': { name: 'Secret' }, 'knowledge_base:kbHere': { name: 'Here' },
    };
    const res = await run(world, [{ kind: 'agent', id: 'ag' }], { attachable: ['kbOk'] });
    assert.strictEqual(byId(res, 'kbOk').status, STATUS.ADDABLE);
    assert.strictEqual(byId(res, 'kbNo').status, STATUS.NOT_YOURS);
    assert.strictEqual(byId(res, 'kbNo').name, null);
    assert.strictEqual(byId(res, 'kbHere').status, STATUS.ALREADY_HERE);
    assert.strictEqual(byId(res, 'kbGone').status, STATUS.NOT_FOUND);
});

test('a part that is also selected is not listed as related; a cycle ends', async () => {
    const world = {
        'automation:a': mine('A', def({ id: 's', type: 'call_block', blockId: 'b' })),
        'automation:b': mine('B', def({ id: 't', type: 'call_block', blockId: 'a' })),
    };
    const both = await run(world, [{ kind: 'automation', id: 'a' }, { kind: 'automation', id: 'b' }]);
    assert.deepStrictEqual(both.related, []);
    const one = await run(world, [{ kind: 'automation', id: 'a' }]);
    assert.deepStrictEqual(one.related.map((p) => p.id), ['b']);
    assert.deepStrictEqual(one.items, [{ kind: 'automation', id: 'a', name: 'A', status: STATUS.ADDABLE }]);
});

test('a selection that is not the caller\'s brings nothing and says why', async () => {
    const world = { 'automation:a': { owner: 'bob', name: 'Bob\'s', payload: def({ id: 's', type: 'call_block', blockId: 'b' }) } };
    const res = await run(world, [{ kind: 'automation', id: 'a' }]);
    assert.deepStrictEqual(res.related, []);
    assert.strictEqual(res.items[0].status, STATUS.NOT_YOURS);
    assert.strictEqual(res.items[0].name, null);
});

test('the walk stops at the cap and says so', async () => {
    const steps = Array.from({ length: MAX_RELATED + 5 }, (_, i) => ({ id: `s${i}`, type: 'datatable', op: 'list', datatableId: `t${i}` }));
    const world = { 'automation:big': mine('Big', def(...steps)) };
    for (let i = 0; i < steps.length; i++) world[`datatable:t${i}`] = mine(`T${i}`);
    const res = await run(world, [{ kind: 'automation', id: 'big' }]);
    assert.strictEqual(res.related.length, MAX_RELATED);
    assert.strictEqual(res.truncated, true);
});

test('a kind this container does not hold is no dependency', async () => {
    const { d } = doubles({
        'automation:a': mine('A', def({ id: 's', type: 'call_block', blockId: 'b' })),
        'automation:b': mine('B', null),
    });
    const res = await findRelatedParts({ project: { ...PROJECT, kind: 'workspace' }, userId: ME, items: [{ kind: 'automation', id: 'a' }] }, d);
    assert.deepStrictEqual(res.related, []);
});

test('every edge graph.js draws for a part is found by this walk too', () => {
    const a1 = {
        id: 'a1', title: 'A', userId: ME,
        definition: { steps: [
            { id: 's1', type: 'call_block', blockId: 'blk' },
            { id: 's2', type: 'datatable', op: 'add_row', datatableId: 'tbl', values: {} },
            { id: 's3', type: 'datatable', op: 'list', datatableId: 'tbl2' },
        ] },
    };
    const app = { id: 'app1', name: 'App', userId: ME, definition: { actions: [{ kind: 'run_automation', automationId: 'a1' }] } };
    const webpage = { id: 'w1', name: 'W', userId: ME, bridgeGrants: { automations: [{ automationId: 'a1' }] } };
    const agent = { id: 'ag', name: 'Ag', ownerId: ME, config: { knowledge_base_ids: ['kb'], attachedSkillIds: ['sk'] } };
    const graph = buildProjectGraph({ automations: [a1], apps: [app], webpages: [webpage], agents: [agent] });

    const payloads = {
        automation: { a1: { definition: a1.definition } },
        app: { app1: { definition: app.definition } },
        webpage: { w1: { bridgeGrants: webpage.bridgeGrants } },
        agent: { ag: { config: agent.config } },
    };
    const wanted = graph.edges.filter((e) => e.targetId && e.to);
    assert.ok(wanted.length >= 7, 'the fixture draws the edges it claims to');
    for (const edge of wanted) {
        const [fromKind, fromId] = edge.from.split(/:(.*)/s);
        const found = edgesOf(fromKind, payloads[fromKind][fromId]).map((e) => `${e.kind}:${e.id}`);
        assert.ok(found.includes(edge.to), `${edge.from} -> ${edge.to} (${edge.kind}) is missing from the walk`);
    }
});
