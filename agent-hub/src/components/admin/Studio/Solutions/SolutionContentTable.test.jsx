import { render, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
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
    it('a live automation says live; a draft says draft', () => {
        const { getByText } = renderTable();
        expect(getByText(/live/)).toBeTruthy();
    });

    it('an automation whose state the listing did not carry says NOTHING about it', () => {
        const { queryByText } = renderTable({
            resources: { ...RESOURCES, automations: [{ id: 'a1', title: 'Nightly', userId: 'alice' }] },
        });
        expect(queryByText(/live/)).toBeNull();
        expect(queryByText(/paused/)).toBeNull();
    });

    it('an automation reachable through a public form says so, from the graph\'s form node', () => {
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

describe('a Solution with no parts', () => {
    const EMPTY = {
        role: 'owner', notebooks: [], apps: [], automations: [], webpages: [], datatables: [], agents: [],
        skills: [], documentTemplates: [], knowledgeBases: [], approvals: [],
    };

    it('shows one friendly placard and the kind tiles, not three empty bands', () => {
        const { getByTestId, queryByTestId, queryByText } = renderTable({ resources: EMPTY, role: 'owner' });
        expect(getByTestId('solution-empty').textContent).toContain('Bring the parts together');
        expect(getByTestId('solution-empty').textContent).toContain('bundles the parts that work together');
        expect(getByTestId('add-kind-tiles')).toBeTruthy();
        expect(queryByTestId('solution-band-people')).toBeNull();
        expect(queryByText('Nothing here yet.')).toBeNull();
    });

    it('a reader who may not add gets the explanation and no tiles', () => {
        const { getByTestId, queryByTestId } = renderTable({ resources: EMPTY, role: 'viewer' });
        expect(getByTestId('solution-empty')).toBeTruthy();
        expect(queryByTestId('add-kind-tiles')).toBeNull();
    });

    it('a section that could not be read is not an empty Solution', () => {
        const { queryByTestId } = renderTable({ resources: { ...EMPTY, agents: null } });
        expect(queryByTestId('solution-empty')).toBeNull();
        expect(queryByTestId('solution-section-unavailable-agents')).toBeTruthy();
    });

    it('a Solution that has parts offers the panel behind one button', async () => {
        const { getByTestId, queryByTestId } = renderTable({ role: 'owner' });
        expect(queryByTestId('add-parts-panel')).toBeNull();
        await userEvent.click(getByTestId('add-parts-open'));
        expect(getByTestId('add-parts-drawer')).toBeTruthy();
        expect(getByTestId('add-parts-panel')).toBeTruthy();
        await userEvent.click(getByTestId('add-parts-close'));
        expect(queryByTestId('add-parts-panel')).toBeNull();
    });

    it('Escape closes the drawer', async () => {
        const { getByTestId, queryByTestId } = renderTable({ role: 'owner' });
        await userEvent.click(getByTestId('add-parts-open'));
        await userEvent.keyboard('{Escape}');
        expect(queryByTestId('add-parts-panel')).toBeNull();
    });

    it('a tile on the empty screen opens the drawer on that kind', async () => {
        const { getByTestId } = renderTable({ resources: EMPTY, role: 'owner' });
        await userEvent.click(getByTestId('add-kind-skill'));
        const drawer = getByTestId('add-parts-drawer');
        await waitFor(() => expect(within(drawer).getByTestId('add-kind-skill').getAttribute('aria-pressed')).toBe('true'));
    });
});

describe('the content toolbar', () => {
    const MANY = { ...RESOURCES, agents: [{ id: 'g1', name: 'Helper', ownerId: 'alice' }] };

    it('searches by name and says so when nothing matches', async () => {
        const { getByTestId, queryByText, getByText } = renderTable({ resources: MANY });
        await userEvent.type(getByTestId('content-search'), 'desk');
        expect(getByText('Desk')).toBeTruthy();
        expect(queryByText('Helper')).toBeNull();
        await userEvent.clear(getByTestId('content-search'));
        await userEvent.type(getByTestId('content-search'), 'zzz');
        expect(getByTestId('content-no-matches')).toBeTruthy();
        await userEvent.click(getByText('Clear filters'));
        expect(getByText('Helper')).toBeTruthy();
    });

    it('offers pills only for kinds that are present, and filters by them', async () => {
        const { getByTestId, queryByTestId, queryByText } = renderTable({ resources: MANY });
        expect(queryByTestId('content-kind-skill')).toBeNull();
        await userEvent.click(getByTestId('content-kind-agent'));
        expect(queryByText('Desk')).toBeNull();
        expect(queryByText('Helper')).toBeTruthy();
    });

    it('shows the status pill only when something needs attention', async () => {
        const none = renderTable({ resources: MANY });
        expect(none.queryByTestId('content-attention')).toBeNull();
        none.unmount();
        const completeness = { findings: [{ severity: 'error', message: 'x', targetRef: { kind: 'app', id: 'app1' } }] };
        const { getByTestId, queryByText } = renderTable({ resources: MANY, completeness });
        await userEvent.click(getByTestId('content-attention'));
        expect(queryByText('Helper')).toBeNull();
        expect(queryByText('Desk')).toBeTruthy();
    });

    it('a viewer gets the toolbar without the add button', () => {
        const { getByTestId, queryByTestId } = renderTable({ resources: MANY, role: 'viewer' });
        expect(getByTestId('content-search')).toBeTruthy();
        expect(queryByTestId('add-parts-open')).toBeNull();
    });
});
