import { render } from '@testing-library/react';
import { describe, it, expect } from 'vitest';

import ProjectFlowTab from './ProjectFlowTab';

/**
 * The Flow tab exists for one reason: two failure modes are invisible
 * everywhere else in the product.
 *
 *   - A CROSS-OWNER edge is wired correctly and refuses at the moment a user
 *     presses the button, because the app action and the webpage bridge both
 *     run acts-as-owner.
 *   - An EXTERNAL dependency is the difference between a Blueprint that
 *     installs working and one that installs inert.
 *
 * So the test that matters most is that a problem is stated in words, not
 * encoded in a colour someone has to know how to read.
 */

const GRAPH = {
    complete: true,
    unavailable: [],
    nodes: [
        { id: 'app:app1', type: 'app', name: 'Invoice desk', entityId: 'app1' },
        { id: 'automation:a1', type: 'automation', name: 'Nightly invoices', entityId: 'a1' },
        { id: 'approval:automation:a1:s1', type: 'approval', name: 'Ship it?', entityId: null },
    ],
    edges: [
        { from: 'app:app1', to: 'automation:a1', kind: 'runs', targetId: 'a1', problem: null },
        { from: 'automation:a1', to: 'approval:automation:a1:s1', kind: 'asks', targetId: null, problem: null },
    ],
    externals: [],
    problems: [],
};

const renderTab = (props = {}) => render(<ProjectFlowTab graph={GRAPH} loading={false} {...props} />);

describe('health', () => {
    it('says so plainly when everything is connected — and the server said it read it all', () => {
        const { getByText } = renderTab();
        expect(getByText('Everything in this project is connected and owned consistently.')).toBeTruthy();
    });

    it('states each problem in words', () => {
        const { getByText } = renderTab({
            graph: {
                ...GRAPH,
                problems: [
                    { code: 'cross_owner', from: 'app:app1', targetId: 'a1', message: 'Invoice desk runs an automation owned by someone else (a1).' },
                    { code: 'external', from: 'app:app1', targetId: 'x', message: 'Invoice desk depends on an automation outside this project (x).' },
                ],
            },
        });
        // Prose, not a colour a reader has to decode.
        expect(getByText('Invoice desk runs an automation owned by someone else (a1).')).toBeTruthy();
        expect(getByText('Invoice desk depends on an automation outside this project (x).')).toBeTruthy();
    });
});

describe('wiring', () => {
    it('groups edges by what does the calling', () => {
        const { getByText, getAllByText, container } = renderTab();
        expect(getByText('Invoice desk')).toBeTruthy();
        expect(getByText('Ship it?')).toBeTruthy();
        // Twice on purpose: the automation is what the app runs AND what asks for
        // the approval, so it heads its own group and appears as a target.
        expect(getAllByText('Nightly invoices')).toHaveLength(2);
        expect(container.querySelectorAll('li')).toHaveLength(2);
    });

    it('names an unwired reference rather than showing a blank row', () => {
        const { getByText } = renderTab({
            graph: {
                ...GRAPH,
                edges: [{ from: 'app:app1', to: null, kind: 'runs', targetId: null, problem: 'unwired' }],
            },
        });
        expect(getByText('nothing picked yet')).toBeTruthy();
    });

    it('says so when nothing calls anything yet', () => {
        const { getByText } = renderTab({ graph: { ...GRAPH, edges: [] } });
        expect(getByText('Nothing in this project calls anything else yet.')).toBeTruthy();
    });
});

describe('external dependencies', () => {
    it('stays hidden when the solution is self-contained', () => {
        const { queryByText } = renderTab();
        expect(queryByText('Depends on things outside this project')).toBeNull();
    });

    it('lists what packaging would not be able to carry', () => {
        const { getByText } = renderTab({
            graph: { ...GRAPH, externals: [{ kind: 'automation', id: 'aut_outside', referencedBy: ['app:app1'] }] },
        });
        expect(getByText('Depends on things outside this project')).toBeTruthy();
        expect(getByText('aut_outside')).toBeTruthy();
    });
});

describe('loading and failure', () => {
    it('spins on first load rather than claiming nothing is wired', () => {
        const { container } = render(<ProjectFlowTab graph={null} loading />);
        expect(container.querySelector('.animate-spin')).toBeTruthy();
    });

    it('says it could not load, not that the project is empty', () => {
        const { getByText } = render(<ProjectFlowTab graph={null} loading={false} />);
        expect(getByText(/Could not load this section/)).toBeTruthy();
    });
});


/**
 * The reason this block exists.
 *
 * GET /:id/graph draws six member kinds independently and NAMES the ones it
 * could not read. Before this, the tab read neither `complete` nor
 * `unavailable`: a graph missing its agents and its automations rendered as
 * "Everything in this project is connected and owned consistently." — the
 * cross-owner edge this tab exists to surface could have been sitting in the
 * half that never loaded. The server-side fail-open was closed in O2 phase 1;
 * this is the same lie one layer up, and these tests hold the client to the
 * same rule the Control tab follows: reassure on `complete === true`, never on
 * an empty list.
 */
describe('a graph the server could not read whole', () => {
    const PARTIAL = { ...GRAPH, complete: false, unavailable: ['agents', 'automations'], problems: [], edges: [] };

    it('says the picture is partial, and names the sections in words', () => {
        const { getByTestId, getByText } = renderTab({ graph: PARTIAL });
        expect(getByTestId('project-flow-incomplete')).toBeTruthy();
        // Not "agents, automations" — the server sends machine keys precisely
        // so the client can put them in the reader's own language.
        expect(getByText('agents, automations')).toBeTruthy();
    });

    it('never says everything is connected when part of it was never read', () => {
        const { queryByText, getByText } = renderTab({ graph: PARTIAL });
        expect(queryByText('Everything in this project is connected and owned consistently.')).toBeNull();
        expect(getByText('Nothing was wrong in the parts that could be read.')).toBeTruthy();
    });

    it('never says nothing calls anything either', () => {
        const { queryByText, getByText } = renderTab({ graph: PARTIAL });
        expect(queryByText('Nothing in this project calls anything else yet.')).toBeNull();
        expect(getByText('Nothing that could be read calls anything else.')).toBeTruthy();
    });

    it('still lists the problems it did find', () => {
        const { getByText, getByTestId } = renderTab({
            graph: { ...PARTIAL, problems: [{ code: 'cross_owner', from: 'app:app1', targetId: 'a1', message: 'Invoice desk runs an automation owned by someone else (a1).' }] },
        });
        expect(getByText('Invoice desk runs an automation owned by someone else (a1).')).toBeTruthy();
        expect(getByTestId('project-flow-incomplete')).toBeTruthy();
    });

    it('names a section it has no word for rather than dropping it', () => {
        // A section added on the server next year. Jargon in the strip beats a
        // strip that quietly lists one gap where the server named two.
        const { getByText } = renderTab({ graph: { ...PARTIAL, unavailable: ['agents', 'somethingNew'] } });
        expect(getByText('agents, somethingNew')).toBeTruthy();
    });

    it('an answer with no verdict in it is treated as partial, not as clean', () => {
        // A cached payload, or a server that predates the field. Unknown
        // narrows: no reassurance, and the tab says why.
        const { complete, unavailable, ...noVerdict } = PARTIAL;   // eslint-disable-line no-unused-vars
        const { getByTestId, queryByText } = renderTab({ graph: noVerdict });
        expect(getByTestId('project-flow-unverified')).toBeTruthy();
        expect(queryByText('Everything in this project is connected and owned consistently.')).toBeNull();
    });

    it('stays quiet on a whole graph — no strip, and the plain sentence', () => {
        const { queryByTestId, getByText } = renderTab({ graph: { ...GRAPH, edges: [] } });
        expect(queryByTestId('project-flow-incomplete')).toBeNull();
        expect(queryByTestId('project-flow-unverified')).toBeNull();
        expect(getByText('Nothing in this project calls anything else yet.')).toBeTruthy();
    });
});
