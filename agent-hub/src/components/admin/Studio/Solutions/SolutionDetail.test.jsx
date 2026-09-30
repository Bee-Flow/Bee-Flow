import { act, fireEvent, render, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../../utils/helpers', () => ({
    API_BASE: '',
    authFetch: (...args) => globalThis.__authFetch(...args),
}));
// De live feed wordt hier NIET uitgezet maar afgevangen: het gedrag dat deze
// tests bewaken is juist wat er gebeurt als er een event binnenkomt.
vi.mock('../../../../hooks/useProjectStream', () => ({
    default: (opts) => { globalThis.__stream = opts; },
}));

// The members panel belongs to the project workspace and has its own tests;
// here it only has to receive the right Solution, role and person.
vi.mock('../../../projects/workspace/ProjectMembersPanel', () => ({
    default: ({ projectId, role, currentUserId, onLeft }) => (
        <div>
            <div data-testid="members-panel">{`${projectId}:${role}:${currentUserId}`}</div>
            <button type="button" data-testid="members-panel-left" onClick={() => onLeft?.()}>left</button>
        </div>
    ),
}));

import SolutionDetail from './SolutionDetail';

/**
 * De naad tussen de Oplossing en de release-track: de twee nieuwe tabs en de
 * "update beschikbaar"-banner.
 *
 * DE BANNER IS DE REDEN DAT DIT BESTAND BESTAAT. Hij belooft iets over een
 * Blueprint van iemand anders, dus hij mag alleen spreken als die Blueprint in
 * de ORG-GESCOOPTE galerijlijst staat — dat is `listBlueprintsFor` aan de
 * serverkant, en de enige lijst die dit scherm daarover mag geloven. Een event
 * uit de feed is een SEIN, geen antwoord: het versienummer in de payload komt
 * nooit op het scherm, want een event kan over een Blueprint gaan die deze lezer
 * niet mag zien.
 */

const CLEAN = { findings: [], blocked: false, complete: true, unavailable: [], requires: { items: [], counts: {} } };

const RELEASES = [{
    id: 'rel_3', version: 3, publishedAt: '2026-09-05T09:00:00Z',
    notes: {
        entities: [{ kind: 'app', entityId: 'app_1', name: 'Desk', change: 'changed', text: null }],
        omitted: 0, textsDropped: false,
    },
}];

/** Een Oplossing die uit bp1 is geïnstalleerd en op v2 staat. */
function installedProject(over = {}) {
    return {
        id: 'p1', name: 'Quotes', permission: 'owner',
        installedFromBlueprintId: 'bp1',
        update: { blueprintId: 'bp1', installedVersion: 2, latestVersion: 3, available: true },
        ...over,
    };
}

function mockFetch({ blueprints = [{ id: 'bp1', version: 3, solutionKey: 'sol_other', createdBy: 'u2' }],
    releases = RELEASES, installs = { installsHere: 2, installsElsewhere: 1 } } = {}) {
    globalThis.__authFetch = vi.fn(async (url) => {
        const ok = (body) => ({ ok: true, status: 200, json: async () => body });
        if (url.includes('/package/blueprints')) return ok({ blueprints });
        if (url.includes('/package/releases')) {
            return releases === null
                ? { ok: false, status: 500, json: async () => ({ error: 'Request failed' }) }
                : ok({ releases });
        }
        if (url.includes('/package/installs')) return ok(installs);
        if (url.includes('/completeness')) return ok(CLEAN);
        if (url.includes('/members')) return ok({ ownerId: 'u1', members: [] });
        if (url.includes('/resources')) return ok({ role: 'owner', notebooks: [], apps: [], automations: [], webpages: [], approvals: [] });
        if (url.includes('/graph')) return ok({ nodes: [], edges: [], externals: [], problems: [], unavailable: [], complete: true });
        if (url.includes('/activity')) return ok([]);
        return ok({});
    });
}

beforeEach(() => { globalThis.__stream = null; mockFetch(); });

describe('the update banner', () => {
    it('says a newer version is available when the scoped listing has the Blueprint', async () => {
        const { findByTestId } = render(<SolutionDetail project={installedProject()} onBack={() => {}} />);
        expect((await findByTestId('solution-update-available')).textContent).toMatch(/Version 3/);
    });

    it('A BLUEPRINT OUTSIDE THIS READER\'S SCOPE PROMISES NOTHING', async () => {
        // De galerijlijst is org-gescoopt en kent bp1 niet: verwijderd, of van
        // een andere organisatie. Het scherm mag dan geen versie noemen — en
        // ook niet zeggen dat alles bij is.
        mockFetch({ blueprints: [{ id: 'bp_someone_else', version: 9 }] });
        const { findByTestId, queryByTestId } = render(<SolutionDetail project={installedProject()} onBack={() => {}} />);
        await findByTestId('solution-update-unknown');
        expect(queryByTestId('solution-update-available')).toBeNull();
    });

    it('a Solution that came from no Blueprint gets no banner at all', async () => {
        const { queryByTestId } = render(
            <SolutionDetail project={{ id: 'p1', name: 'Quotes', permission: 'owner', installedFromBlueprintId: null, update: null }} onBack={() => {}} />,
        );
        await waitFor(() => expect(globalThis.__authFetch).toHaveBeenCalled());
        expect(queryByTestId('solution-update-available')).toBeNull();
        expect(queryByTestId('solution-update-unknown')).toBeNull();
    });

    it('an unknown installed version is unknown, not "there is an update"', async () => {
        const { findByTestId, queryByTestId } = render(
            <SolutionDetail project={installedProject({ update: { blueprintId: 'bp1', installedVersion: null } })} onBack={() => {}} />,
        );
        await findByTestId('solution-update-unknown');
        expect(queryByTestId('solution-update-available')).toBeNull();
    });

    it('only an owner is offered the button; everyone else still gets the sentence', async () => {
        mockFetch();
        globalThis.__authFetch = vi.fn(async (url) => {
            const ok = (body) => ({ ok: true, status: 200, json: async () => body });
            if (url.includes('/package/blueprints')) return ok({ blueprints: [{ id: 'bp1', version: 3 }] });
            if (url.includes('/resources')) return ok({ role: 'viewer' });
            if (url.includes('/completeness')) return ok(CLEAN);
            return ok({});
        });
        const { findByTestId, queryByTestId } = render(
            <SolutionDetail project={installedProject({ permission: 'viewer' })} onBack={() => {}} />,
        );
        await findByTestId('solution-update-available');
        expect(queryByTestId('solution-update-open')).toBeNull();
    });
});

describe('blueprint.published on the live feed', () => {
    it('re-asks the SCOPED listing rather than believing the event', async () => {
        // Eerst niets in de galerij: geen belofte.
        mockFetch({ blueprints: [] });
        const { findByTestId, queryByTestId } = render(<SolutionDetail project={installedProject()} onBack={() => {}} />);
        await findByTestId('solution-update-unknown');

        // Het event noemt een versie 9. Dat getal mag NIET op het scherm komen —
        // het antwoord komt uit de opnieuw gelezen, org-gescoopte lijst.
        mockFetch({ blueprints: [{ id: 'bp1', version: 4 }] });
        await act(async () => {
            globalThis.__stream.onEvent('blueprint.published', { payload: { version: 9 }, targetId: 'bp1' });
        });
        const banner = await findByTestId('solution-update-available');
        expect(banner.textContent).toMatch(/Version 4/);
        expect(banner.textContent).not.toMatch(/Version 9/);
        expect(queryByTestId('solution-update-unknown')).toBeNull();
    });

    it('an event about a Blueprint the reader still may not see changes nothing', async () => {
        mockFetch({ blueprints: [] });
        const { findByTestId, queryByTestId } = render(<SolutionDetail project={installedProject()} onBack={() => {}} />);
        await findByTestId('solution-update-unknown');

        await act(async () => {
            globalThis.__stream.onEvent('blueprint.published', { payload: { version: 12 }, targetId: 'bp1' });
        });
        await waitFor(() => expect(globalThis.__authFetch.mock.calls.filter(([u]) => String(u).includes('/package/blueprints')).length)
            .toBeGreaterThan(1));
        expect(queryByTestId('solution-update-available')).toBeNull();
    });

    it('refreshes the release history too', async () => {
        const { findByText } = render(<SolutionDetail project={installedProject()} onBack={() => {}} />);
        fireEvent.click(await findByText('Versions'));
        await findByText('Desk');
        const before = globalThis.__authFetch.mock.calls.filter(([u]) => String(u).includes('/package/releases')).length;
        await act(async () => {
            globalThis.__stream.onEvent('blueprint.published', { payload: {} });
        });
        await waitFor(() => expect(globalThis.__authFetch.mock.calls.filter(([u]) => String(u).includes('/package/releases')).length)
            .toBeGreaterThan(before));
    });
});

describe('filing on the live feed', () => {
    const reads = (part) => globalThis.__authFetch.mock.calls.filter(([u]) => String(u).includes(part)).length;

    // A notebook, document or meeting filed in or out is announced as
    // content.moved_in / content.moved_out, not as resource_added / _removed;
    // the Solution's contents, graph and publish check must follow either way.
    it.each(['content.moved_in', 'content.moved_out'])('%s refetches the contents, the graph and the check', async (kind) => {
        render(<SolutionDetail project={installedProject()} onBack={() => {}} />);
        await waitFor(() => expect(reads('/graph')).toBeGreaterThan(0));
        await waitFor(() => expect(reads('/completeness')).toBeGreaterThan(0));
        const before = { resources: reads('/resources'), graph: reads('/graph'), completeness: reads('/completeness') };
        await act(async () => { globalThis.__stream.onEvent(kind, { targetId: 'nb1' }); });
        await waitFor(() => {
            expect(reads('/resources')).toBeGreaterThan(before.resources);
            expect(reads('/graph')).toBeGreaterThan(before.graph);
            expect(reads('/completeness')).toBeGreaterThan(before.completeness);
        });
    });
});

describe('the two new tabs', () => {
    it('Versions shows the boolean diff even when no summary line was written', async () => {
        const { findByText, findByTestId } = render(<SolutionDetail project={installedProject()} onBack={() => {}} />);
        fireEvent.click(await findByText('Versions'));
        expect(await findByTestId('version-group-changed')).toBeTruthy();
        expect(await findByTestId('version-note-nosummary')).toBeTruthy();
    });

    it('a release history that could not be read does not read as "never published"', async () => {
        mockFetch({ releases: null });
        const { findByText, findByTestId, queryByTestId } = render(<SolutionDetail project={installedProject()} onBack={() => {}} />);
        fireEvent.click(await findByText('Versions'));
        expect(await findByTestId('versions-unreadable')).toBeTruthy();
        expect(queryByTestId('versions-none')).toBeNull();
    });

    it('Installs shows the two counts and says the number is a lower bound', async () => {
        const { findByText, findByTestId } = render(<SolutionDetail project={installedProject()} onBack={() => {}} />);
        fireEvent.click(await findByText('Installs'));
        expect((await findByTestId('installs-here')).textContent).toMatch(/2 Solutions/);
        expect((await findByTestId('installs-incomplete')).textContent).toMatch(/at least this many/);
    });

    it('the install count is asked for as the header paints, not only when the tab opens', async () => {
        render(<SolutionDetail project={installedProject()} onBack={() => {}} />);
        await waitFor(() => expect(globalThis.__authFetch.mock.calls.some(([u]) => String(u).includes('/package/installs'))).toBe(true));
    });
});

describe('the upgrade dialog', () => {
    it('opens from the banner and asks the plan route for the Blueprint by id', async () => {
        const { findByTestId } = render(<SolutionDetail project={installedProject()} onBack={() => {}} />);
        fireEvent.click(await findByTestId('solution-update-open'));
        await waitFor(() => {
            const call = globalThis.__authFetch.mock.calls.find(([u]) => String(u).includes('/package/upgrade/plan'));
            expect(call).toBeTruthy();
            expect(JSON.parse(call[1].body)).toEqual({ blueprintId: 'bp1' });
        });
    });
});

describe('who can open the Solution', () => {
    const membersReads = () => globalThis.__authFetch.mock.calls.filter(([u]) => String(u).includes('/members')).length;

    it('manages access in place instead of sending the builder to the projects pages', async () => {
        const { findByTestId, queryByText } = render(
            <SolutionDetail project={installedProject()} onBack={() => {}} currentUserId="u1" />,
        );
        expect(await findByTestId('solution-manage-access')).toBeTruthy();
        expect(queryByText('Open in Projects')).toBeNull();
    });

    it('opens the members panel for this Solution, with the caller\'s role', async () => {
        const { findByTestId } = render(
            <SolutionDetail project={installedProject()} onBack={() => {}} currentUserId="u1" />,
        );
        // The role comes from the resources read; wait for it before opening.
        await waitFor(() => expect(globalThis.__authFetch.mock.calls.some(([u]) => String(u).includes('/resources'))).toBe(true));
        await userEvent.click(await findByTestId('solution-manage-access'));
        expect((await findByTestId('members-panel')).textContent).toBe('p1:owner:u1');
    });

    it('re-reads the members for the header capsule when the dialog closes', async () => {
        const { findByTestId, queryByTestId } = render(
            <SolutionDetail project={installedProject()} onBack={() => {}} currentUserId="u1" />,
        );
        await userEvent.click(await findByTestId('solution-manage-access'));
        await findByTestId('members-panel');
        const before = membersReads();
        await userEvent.keyboard('{Escape}');
        await waitFor(() => expect(queryByTestId('members-panel')).toBeNull());
        await waitFor(() => expect(membersReads()).toBeGreaterThan(before));
    });

    it('leaves the Solution page, and does not re-read its members, once the caller left it', async () => {
        const onBack = vi.fn();
        const { findByTestId, queryByTestId } = render(
            <SolutionDetail project={installedProject({ permission: 'viewer' })} onBack={onBack} currentUserId="u2" />,
        );
        await userEvent.click(await findByTestId('solution-manage-access'));
        await findByTestId('members-panel');
        const before = membersReads();
        await userEvent.click(await findByTestId('members-panel-left'));
        await waitFor(() => expect(onBack).toHaveBeenCalledTimes(1));
        await waitFor(() => expect(queryByTestId('members-panel')).toBeNull());
        expect(membersReads()).toBe(before);
    });

    it('gives a viewer the panel too, as a viewer', async () => {
        mockFetch();
        const base = globalThis.__authFetch;
        globalThis.__authFetch = vi.fn(async (url, init) => (String(url).includes('/resources')
            ? { ok: true, status: 200, json: async () => ({ role: 'viewer', notebooks: [], apps: [], automations: [], webpages: [], approvals: [] }) }
            : base(url, init)));
        const { findByTestId } = render(
            <SolutionDetail project={installedProject({ permission: 'viewer' })} onBack={() => {}} currentUserId="u2" />,
        );
        await waitFor(() => expect(globalThis.__authFetch.mock.calls.some(([u]) => String(u).includes('/resources'))).toBe(true));
        await userEvent.click(await findByTestId('solution-manage-access'));
        expect((await findByTestId('members-panel')).textContent).toBe('p1:viewer:u2');
    });
});
