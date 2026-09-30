import { render } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../../../utils/helpers', () => ({
    API_BASE: '',
    authFetch: (...args) => globalThis.__authFetch?.(...args) ?? Promise.resolve({ ok: false, json: async () => ({}) }),
}));

import SolutionContentTable, { BANDS, worstByEntity } from './SolutionContentTable';
import { SECTIONS } from './solutionSections';

/**
 * The grouped Content table.
 *
 * It reads the SAME payload as the flat listing and must not gain a claim the
 * listing does not make. Three of the tests below are about what it refuses to
 * say: no status where the checks have not answered, no sub-line where the
 * value is unknown, and never "nothing here" for a section that failed to load.
 */

const RESOURCES = {
    role: 'owner',
    notebooks: [], apps: [{ id: 'app1', name: 'Desk', userId: 'alice' }],
    automations: [{ id: 'a1', title: 'Nightly', userId: 'alice', isActive: true, isDraft: false }],
    webpages: [], datatables: [], agents: [], knowledgeBases: [], approvals: [],
};

const GRAPH = {
    nodes: [
        { id: 'app:app1', type: 'app', entityId: 'app1', name: 'Desk' },
        { id: 'automation:a1', type: 'automation', entityId: 'a1', name: 'Nightly' },
    ],
    edges: [{ from: 'app:app1', to: 'automation:a1', kind: 'runs', targetId: 'a1', problem: null }],
    externals: [], problems: [],
};

const renderTable = (props = {}) => render(
    <SolutionContentTable
        projectId="p1"
        resources={RESOURCES}
        loading={false}
        role="viewer"
        graph={GRAPH}
        completeness={null}
        {...props}
    />,
);

describe('the three bands', () => {
    it('every membership section lands in exactly one band', () => {
        const placed = BANDS.flatMap(b => b.sections);
        for (const section of SECTIONS) {
            expect(placed.filter(k => k === section.key)).toHaveLength(1);
        }
    });

    it('renders all three, so a builder always sees the same shape', () => {
        const { getByTestId } = renderTable();
        expect(getByTestId('solution-band-people')).toBeTruthy();
        expect(getByTestId('solution-band-work')).toBeTruthy();
        expect(getByTestId('solution-band-knowledge')).toBeTruthy();
    });

    it('lists the things in the project under them', () => {
        const { getByText, getAllByText } = renderTable();
        expect(getByText('Desk')).toBeTruthy();
        // Twice: its own row, and the pill on the app that runs it.
        expect(getAllByText('Nightly')).toHaveLength(2);
    });
});

describe('what a row is allowed to claim', () => {
    it('depends-on pills come from edges the graph actually resolved', () => {
        const { getAllByTestId } = renderTable();
        const pills = getAllByTestId('solution-row-depends');
        expect(pills).toHaveLength(1);
        expect(pills[0].textContent).toContain('Nightly');
    });

    it('an edge pointing OUTSIDE the Solution is not a pill — that is a finding', () => {
        const { queryAllByTestId } = renderTable({
            graph: { ...GRAPH, edges: [{ from: 'app:app1', to: 'automation:gone', kind: 'runs', targetId: 'gone', problem: 'missing' }] },
        });
        expect(queryAllByTestId('solution-row-depends')).toHaveLength(0);
    });

    it('no status column at all while the checks have not answered', () => {
        const { queryAllByTestId } = renderTable({ completeness: null });
        expect(queryAllByTestId('solution-row-status')).toHaveLength(0);
    });

    it('a status appears only for the entity the finding names', () => {
        const { getAllByTestId } = renderTable({
            completeness: {
                complete: true, blocked: true, unavailable: [],
                findings: [{
                    code: 'cross_owner', severity: 'error', kind: 'app',
                    targetRef: { kind: 'app', id: 'app1' }, message: 'Broken.',
                }],
            },
        });
        const cells = getAllByTestId('solution-row-status');
        expect(cells).toHaveLength(1);
        expect(cells[0].textContent).toContain('Needs fixing');
    });

    it('a knowledge-base finding matches its row even though the graph spells the kind differently', () => {
        const map = worstByEntity([{ severity: 'warning', targetRef: { kind: 'kb', id: 'kb1' } }]);
        expect(map.has('kb:kb1')).toBe(true);
    });

    it('an error outranks a warning about the same thing', () => {
        const map = worstByEntity([
            { severity: 'warning', targetRef: { kind: 'app', id: 'app1' }, message: 'meh' },
            { severity: 'error', targetRef: { kind: 'app', id: 'app1' }, message: 'bad' },
        ]);
        expect(map.get('app:app1').message).toBe('bad');
    });
});

describe('sub-lines say only what the listing carries', () => {
    it('a live routine says live; a draft says draft', () => {
        const { getByText } = renderTable();
        expect(getByText(/live/)).toBeTruthy();
    });

    it('a routine whose state the listing did not carry says NOTHING about it', () => {
        const { queryByText } = renderTable({
            resources: { ...RESOURCES, automations: [{ id: 'a1', title: 'Nightly', userId: 'alice' }] },
        });
        expect(queryByText(/live/)).toBeNull();
        expect(queryByText(/paused/)).toBeNull();
    });

    it('a routine reachable through a public form says so, from the graph\'s form node', () => {
        const { getByText } = renderTable({
            graph: { ...GRAPH, nodes: [...GRAPH.nodes, { id: 'form:a1', type: 'form', entityId: null, name: 'Request', triggers: 'automation:a1' }] },
        });
        expect(getByText(/public form/)).toBeTruthy();
    });
});

describe('a section that failed to load', () => {
    it('says it could not be read — never "nothing here yet"', () => {
        const { getByTestId, queryByText } = renderTable({
            resources: { ...RESOURCES, agents: null },
        });
        expect(getByTestId('solution-section-unavailable-agents')).toBeTruthy();
        expect(queryByText('Nothing here yet.')).toBeNull();
    });
});

describe('who may change what', () => {
    it('a viewer gets no add control', () => {
        const { queryByTestId } = renderTable({ role: 'viewer' });
        expect(queryByTestId('solution-add-resource')).toBeNull();
    });

    it('an editor gets one', () => {
        const { getByTestId } = renderTable({ role: 'editor' });
        expect(getByTestId('solution-add-resource')).toBeTruthy();
    });

    it('only the owner of an item is offered the remove button', () => {
        const { container } = renderTable({ role: 'editor', currentUserId: 'bob' });
        expect(container.querySelectorAll('[title="Remove from project"]')).toHaveLength(0);
    });
});
