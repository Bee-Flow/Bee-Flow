/**
 * The Content tab decided: bands in order, a section that could not be read
 * kept apart from one with nothing in it, each row carrying only what the
 * payloads say (its dependencies on drawn nodes, its worst finding, the facts
 * its listing carries) — plus the wiring the Flow tab groups and the Overview
 * tab's counts.
 */

import { translate } from '@/core/i18n';

import { contentBands, sectionCounts, subLines } from './content';
import { dependenciesByNode, formTriggeredRoutines, wiringGroups } from './graph';
import type { Finding, SolutionGraph } from './solution';
import type { ProjectResources } from './types';

const EMPTY: ProjectResources = {
    role: 'owner',
    notebooks: [],
    automations: [],
    apps: [],
    webpages: [],
    datatables: [],
    agents: [],
    knowledgeBases: [],
    approvals: [],
};

const GRAPH: SolutionGraph = {
    nodes: [
        { id: 'app:a1', type: 'app', name: 'Portal', entityId: 'a1', triggers: null },
        { id: 'automation:r1', type: 'automation', name: 'Intake', entityId: 'r1', triggers: null },
        { id: 'form:f', type: 'form', name: 'Public form', entityId: null, triggers: 'automation:r1' },
    ],
    edges: [
        { from: 'app:a1', to: 'automation:r1', kind: 'runs', targetId: 'r1', problem: null },
        { from: 'app:a1', to: 'automation:r1', kind: 'runs', targetId: 'r1', problem: null },
        { from: 'app:a1', to: 'automation:gone', kind: 'runs', targetId: 'gone', problem: 'missing' },
        { from: 'form:f', to: 'automation:r1', kind: 'triggers', targetId: 'r1', problem: null },
    ],
    externals: [],
    problems: [],
    unavailable: [],
    complete: true,
};

const WARNING: Finding = {
    code: 'app.unwired',
    severity: 'warning',
    message: 'Portal has a button with no routine.',
    remediation: null,
    blockedAt: null,
    deepLink: null,
    targetRef: { kind: 'app', id: 'a1' },
    from: null,
    targetId: null,
};

describe('contentBands', () => {
    const bands = contentBands({
        resources: {
            ...EMPTY,
            apps: [{ id: 'a1', name: 'Portal', userId: 'me' }],
            automations: [{ id: 'r1', title: 'Intake', userId: 'you', isActive: true, isDraft: true }],
            datatables: null,
        },
        graph: GRAPH,
        completeness: { blocked: false, complete: true, findings: [WARNING], unavailable: [] },
        meId: 'me',
        canEdit: true,
    });

    it('keeps the web’s three bands, and says which section could not be read', () => {
        expect(bands.map((b) => b.band)).toEqual(['people', 'work', 'knowledge']);
        const knowledge = bands[2]!;
        expect(knowledge.sections.find((s) => s.section.key === 'datatables')?.state).toBe('unavailable');
        expect(knowledge.empty).toBe(false);
    });

    it('draws each row from the payloads only', () => {
        const app = bands[0]!.sections.find((s) => s.section.key === 'apps');
        const row = app?.state === 'rows' ? app.rows[0] : undefined;
        expect(row?.dependsOn.map((n) => n.name)).toEqual(['Intake']);
        expect(row?.finding?.code).toBe('app.unwired');
        expect(row?.removable).toBe(true);

        const routines = bands[1]!.sections.find((s) => s.section.key === 'automations');
        const routine = routines?.state === 'rows' ? routines.rows[0] : undefined;
        expect(routine?.removable).toBe(false);
        expect(routine && subLines(routine, translate)).toEqual(['live', 'draft', 'public form']);
    });

    it('calls a band empty only when every section in it answered with nothing', () => {
        const none = contentBands({ resources: EMPTY, graph: null, completeness: null, meId: undefined, canEdit: false });
        expect(none.every((b) => b.empty)).toBe(true);
    });
});

describe('the graph readings', () => {
    it('resolves dependencies to drawn nodes only, once each', () => {
        expect(dependenciesByNode(GRAPH).get('app:a1')?.map((n) => n.id)).toEqual(['automation:r1']);
        expect(dependenciesByNode(null).size).toBe(0);
        expect([...formTriggeredRoutines(GRAPH)]).toEqual(['automation:r1']);
    });

    it('groups edges by what does the calling, with the target when it was drawn', () => {
        const groups = wiringGroups(GRAPH);
        expect(groups.map((g) => [g.fromId, g.edges.length])).toEqual([['app:a1', 3], ['form:f', 1]]);
        expect(groups[0]!.edges[2]!.target).toBeNull();
        expect(groups[0]!.from?.name).toBe('Portal');
    });
});

describe('sectionCounts', () => {
    it('counts each kind, a dash for one that could not be read, and approvals still waiting', () => {
        const counts = sectionCounts({
            ...EMPTY,
            apps: [{ id: 'a' }, { id: 'b' }],
            webpages: null,
            approvals: [{ id: '1', status: 'pending' }, { id: '2', status: 'approved' }, { id: '3' }],
        });
        const by = Object.fromEntries(counts.map((c) => [c.key, c.count]));
        expect(by).toMatchObject({ apps: 2, webpages: null, approvals: 2, notebooks: 0 });
        expect(sectionCounts(null).every((c) => c.count === null)).toBe(true);
    });
});
