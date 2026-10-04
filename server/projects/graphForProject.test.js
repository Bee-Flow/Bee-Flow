/**
 * projects/graphForProject.js — the loader behind the graph, the completeness
 * check and the server-side publish gate, driven through its `deps` seam.
 *
 * Pinned here:
 *   1. it reads every member kind of the project it is given (an id or a row);
 *   2. a store that throws is NAMED in `unavailable`, never read as empty;
 *   3. an app or agent whose full read fails is counted, not dropped silently;
 *   4. the automation existence pass is all-or-nothing;
 *   5. the members travel back with the graph, the same rows it was drawn from.
 *
 * No module mocking: every store is an injected double.
 *
 * Run: cd server && node --test projects/graphForProject.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { buildGraphForProject } = require('./graphForProject');

const quietLog = { warn() {}, info() {}, error() {}, debug() {} };

function makeDeps(over = {}) {
    const calls = [];
    const note = (name, args) => calls.push({ name, args });
    const deps = {
        automationStore: {
            getAutomationsForProject: async (id, opts) => { note('automations', { id, opts }); return over.automations || []; },
            getAutomation: async (id) => {
                note('getAutomation', { id });
                if (over.existenceThrows) throw new Error('down');
                return (over.known || []).includes(id) ? { id } : null;
            },
        },
        studioAppStore: {
            listProjectApps: async (id) => { note('apps', { id }); return over.appMetas || []; },
            getStudioApp: async (id) => {
                if (over.appReadFails === id) throw new Error('app read failed');
                return (over.apps || {})[id] || null;
            },
        },
        webpageStore: { listProjectWebpages: async (id) => { note('webpages', { id }); if (over.webpagesThrow) throw new Error('down'); return []; } },
        datatableStore: { listDatatablesForProject: async (id) => { note('datatables', { id }); return []; } },
        agentStore: {
            listProjectAgents: async (id) => { note('agents', { id }); return over.agentMetas || []; },
            getAgent: async (id) => (over.agents || {})[id] || null,
        },
        kbMembership: { listProjectKnowledgeBases: async (id) => { note('kbs', { id }); return over.kbs || []; } },
        kbSources: { listByKb: async (id) => (over.kbSources || {})[id] || [] },
        buildProjectGraph: (input) => {
            note('buildProjectGraph', input);
            const externals = (over.externals || []).map(id => ({ kind: 'automation', id }));
            return { nodes: [], edges: [], externals, problems: [], known: input.knownAutomationIds ? [...input.knownAutomationIds] : null };
        },
        log: quietLog,
    };
    return { deps, calls };
}

test('reads every member kind of the project, by id or by row', async () => {
    for (const project of ['p1', { id: 'p1', name: 'Desk' }]) {
        const { deps, calls } = makeDeps();
        const out = await buildGraphForProject(project, deps);
        for (const kind of ['automations', 'apps', 'webpages', 'datatables', 'agents', 'kbs']) {
            assert.strictEqual(calls.find(c => c.name === kind)?.args.id, 'p1', kind);
        }
        assert.deepStrictEqual(calls.find(c => c.name === 'automations').args.opts, { kinds: ['automation', 'block', 'layer'] });
        assert.deepStrictEqual(out.unavailable, []);
        assert.strictEqual(out.graph.complete, true);
    }
});

test('a project without an id is a caller bug', async () => {
    const { deps } = makeDeps();
    await assert.rejects(() => buildGraphForProject(null, deps), TypeError);
});

test('a store that throws is named, not emptied', async () => {
    const { deps } = makeDeps({ webpagesThrow: true });
    const out = await buildGraphForProject('p1', deps);
    assert.deepStrictEqual(out.unavailable, ['webpages']);
    assert.strictEqual(out.graph.complete, false);
    assert.deepStrictEqual(out.graph.unavailable, ['webpages']);
});

test('an app whose definition will not load is counted, not dropped silently', async () => {
    const { deps } = makeDeps({
        appMetas: [{ id: 'a1' }, { id: 'a2' }],
        apps: { a1: { id: 'a1', definition: {} }, a2: { id: 'a2', definition: {} } },
        appReadFails: 'a2',
    });
    const out = await buildGraphForProject('p1', deps);
    assert.deepStrictEqual(out.unavailable, ['apps']);
    assert.deepStrictEqual(out.members.apps.map(a => a.id), ['a1']);
});

test('agents reach the graph with their wiring only', async () => {
    const { deps, calls } = makeDeps({
        agentMetas: [{ id: 'g1' }],
        agents: { g1: { id: 'g1', name: 'Helper', owner_id: 'u1', config: { knowledge_base_ids: ['kb1'] }, instructions: 'secret' } },
    });
    await buildGraphForProject('p1', deps);
    const input = calls.find(c => c.name === 'buildProjectGraph').args;
    assert.deepStrictEqual(input.agents, [{ id: 'g1', name: 'Helper', ownerId: 'u1', config: { knowledge_base_ids: ['kb1'] } }]);
});

test('meeting-tag knowledge sources are passed to the graph', async () => {
    const { deps, calls } = makeDeps({
        kbs: [{ id: 'kb1' }],
        kbSources: { kb1: [{ kind: 'meeting_tag', config: { tag: ' sales ' } }, { kind: 'url', config: {} }] },
    });
    await buildGraphForProject('p1', deps);
    const input = calls.find(c => c.name === 'buildProjectGraph').args;
    assert.deepStrictEqual(input.meetingSources, [{ knowledgeBaseId: 'kb1', tag: 'sales' }]);
});

test('a complete existence pass redraws the graph with the automations it found', async () => {
    const { deps, calls } = makeDeps({ externals: ['r1', 'r2'], known: ['r1'] });
    const out = await buildGraphForProject('p1', deps);
    assert.strictEqual(calls.filter(c => c.name === 'buildProjectGraph').length, 2);
    assert.deepStrictEqual(out.graph.known, ['r1']);
    assert.deepStrictEqual(out.unavailable, []);
});

test('an existence pass that cannot finish is abandoned and named', async () => {
    const { deps, calls } = makeDeps({ externals: ['r1'], existenceThrows: true });
    const out = await buildGraphForProject('p1', deps);
    assert.strictEqual(calls.filter(c => c.name === 'buildProjectGraph').length, 1, 'no second pass on partial knowledge');
    assert.deepStrictEqual(out.unavailable, ['automationExistence']);
    assert.strictEqual(out.graph.known, null);
});

test('the members travel back with the graph', async () => {
    const automations = [{ id: 'r1', definition: {} }];
    const kbs = [{ id: 'kb1' }];
    const { deps } = makeDeps({ automations, kbs });
    const out = await buildGraphForProject('p1', deps);
    assert.strictEqual(out.members.automations, automations);
    assert.strictEqual(out.members.knowledgeBases, kbs);
    assert.deepStrictEqual(out.members.apps, []);
});
