import { act, fireEvent, render, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, it, expect, vi, beforeEach } from 'vitest';

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

// The licence context is app-wide; the settings page only asks whether approvals are licensed.
vi.mock('../../../licensing/LicenseContext', () => ({
    useLicenseContext: () => ({ hasFeature: () => true, entDegraded: false, entError: null }),
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

describe('a Solution with stages', () => {
    const DEV = { aheadOf: null, checks: { blocked: false, count: 0 } };
    const UAT = {
        stage: 'uat', projectId: 'p_uat', currentRelease: { id: 'rel_7', seq: 7 }, previousRelease: null,
        lastDeployment: { id: 'd7', status: 'succeeded', kind: 'deploy', releaseSeq: 7, finishedAt: '2026-10-01T10:00:00Z' },
        pending: null, bindingsPending: false, enabled: true, role: 'owner',
    };
    const PRD = { ...UAT, stage: 'prd', projectId: 'p_prd', currentRelease: { id: 'rel_5', seq: 5 }, lastDeployment: null };
    const STAGE_RESOURCES = {
        role: 'owner', notebooks: [],
        apps: [{ id: 'a1', name: 'Desk', userId: 'u1' }],
        automations: [{ id: 'r1', name: 'Check VAT', userId: 'u1', isActive: true }],
        webpages: [], approvals: [],
    };

    function mockStages({ pipeline = { dev: DEV, stages: [UAT, PRD], releases: [] }, pipelineOk = true, pipelineStatus = 500 } = {}) {
        globalThis.__authFetch = vi.fn(async (url) => {
            const ok = (body) => ({ ok: true, status: 200, json: async () => body });
            if (url.endsWith('/pipeline')) return pipelineOk ? ok(pipeline) : { ok: false, status: pipelineStatus, json: async () => ({}) };
            if (url.includes('/p_uat/resources')) return ok(STAGE_RESOURCES);
            if (url.includes('/p_uat/graph')) return ok({ nodes: [], edges: [], externals: [], problems: [], unavailable: [], complete: true });
            if (url.includes('/p_uat/stages') || url.includes('/stages/uat')) return ok({ enabled: true, bindingsPending: false, inbound: [{ kind: 'webhook', label: 'Webhook', url: 'https://x.example/webhook/abc' }] });
            if (url.includes('/deployments')) return ok({ deployments: [{ id: 'd7', status: 'succeeded', kind: 'deploy', releaseSeq: 7 }] });
            if (url.includes('/resources')) return ok({ role: 'owner', notebooks: [], apps: [], automations: [], webpages: [], approvals: [] });
            if (url.includes('/completeness')) return ok(CLEAN);
            if (url.includes('/package/blueprints')) return ok({ blueprints: [] });
            if (url.includes('/members')) return ok({ ownerId: 'u1', members: [] });
            return ok({});
        });
    }
    const project = { id: 'p1', name: 'Quotes', permission: 'owner', installedFromBlueprintId: null, update: null };
    const urlStage = () => new URLSearchParams(window.location.search).get('stage');
    afterEach(() => window.history.replaceState(null, '', '/'));

    it('shows the stage rail and a Pipeline tab for Dev', async () => {
        mockStages();
        const { findByTestId, findByText } = render(<SolutionDetail project={project} onBack={() => {}} />);
        expect(await findByTestId('stage-rail')).toBeTruthy();
        expect(await findByText('Pipeline')).toBeTruthy();
    });

    it('a Solution without stages shows the rail with Set up stages, and the stages open nothing', async () => {
        mockStages({ pipeline: { dev: DEV, stages: [], releases: [] } });
        const { findByTestId } = render(<SolutionDetail project={project} onBack={() => {}} />);
        expect((await findByTestId('stage-rail-action')).textContent).toBe('Set up stages');
        expect((await findByTestId('stage-rail-uat')).tagName).toBe('DIV');
    });

    it('a pipeline that could not be read keeps Dev and the Pipeline tab, and says so there', async () => {
        mockStages({ pipelineOk: false });
        const user = userEvent.setup();
        const { findByTestId, findByText, queryByTestId } = render(<SolutionDetail project={project} onBack={() => {}} />);
        await findByTestId('solution-publish');
        expect(queryByTestId('stage-rail')).toBeNull();
        await user.click(await findByText('Pipeline'));
        const problem = await findByTestId('pipeline-read-problem');
        expect(problem.getAttribute('data-state')).toBe('unreadable');
    });

    it('a Solution that is not licensed for stages says so in the Pipeline tab', async () => {
        mockStages({ pipelineOk: false, pipelineStatus: 402 });
        const user = userEvent.setup();
        const { findByText, findByTestId } = render(<SolutionDetail project={project} onBack={() => {}} />);
        await user.click(await findByText('Pipeline'));
        expect((await findByTestId('pipeline-read-problem')).getAttribute('data-state')).toBe('no_licence');
    });

    it('a pipeline that does not exist for this project (404) has no Pipeline tab', async () => {
        mockStages({ pipelineOk: false, pipelineStatus: 404 });
        const { findByTestId, queryByText } = render(<SolutionDetail project={project} onBack={() => {}} />);
        await findByTestId('solution-publish');
        expect(queryByText('Pipeline')).toBeNull();
    });

    it('choosing UAT opens its Status, mirrors ?stage= and hides rename, publish and adding', async () => {
        mockStages();
        const user = userEvent.setup();
        const { findByTestId, queryByTestId } = render(<SolutionDetail project={project} onBack={() => {}} />);
        // On Dev the name is a rename button.
        expect((await findByTestId('studio-section-title')).tagName).toBe('BUTTON');

        await user.click(await findByTestId('stage-rail-uat'));
        expect(await findByTestId('stage-status')).toBeTruthy();
        expect((await findByTestId('stage-status-release')).textContent).toBe('Release 7');
        expect(urlStage()).toBe('uat');
        // The stage is read from its own project id.
        expect(globalThis.__authFetch.mock.calls.some(([u]) => String(u).includes('/api/projects/p_uat/resources'))).toBe(true);
        expect((await findByTestId('studio-section-title')).tagName).toBe('H1');
        expect(queryByTestId('solution-publish')).toBeNull();
        expect(queryByTestId('solution-export')).toBeNull();
        expect(queryByTestId('solution-manage-access')).toBeNull();
        expect((await findByTestId('stage-addresses')).textContent).toMatch(/webhook\/abc/);
    });

    it('the stage Content has no add and no remove', async () => {
        mockStages();
        const user = userEvent.setup();
        window.history.replaceState(null, '', '/?stage=uat');
        const { findByRole, findByText, queryByTestId, container } = render(<SolutionDetail project={project} onBack={() => {}} currentUserId="u1" />);
        await user.click(await findByRole('radio', { name: /Content/ }));
        expect(await findByText('Check VAT')).toBeTruthy();
        expect(queryByTestId('solution-add-resource')).toBeNull();
        // The row would offer a remove button to its owner on Dev.
        expect(container.querySelectorAll('[data-testid="solution-row"] button').length).toBe(2);
    });

    it('History lists the deployments of that stage', async () => {
        mockStages();
        window.history.replaceState(null, '', '/?stage=uat');
        const user = userEvent.setup();
        const { findByText, findAllByTestId } = render(<SolutionDetail project={project} onBack={() => {}} />);
        await user.click(await findByText('History'));
        expect((await findAllByTestId('stage-history-row'))).toHaveLength(1);
        expect(globalThis.__authFetch.mock.calls.some(([u]) => String(u).includes('/api/projects/p1/deployments?stage=uat'))).toBe(true);
    });

    it('a stage the pipeline does not list falls back to Dev', async () => {
        mockStages({ pipeline: { dev: DEV, stages: [UAT], releases: [] } });
        window.history.replaceState(null, '', '/?stage=prd');
        const { findByTestId, queryByTestId } = render(<SolutionDetail project={project} onBack={() => {}} />);
        expect(await findByTestId('solution-publish')).toBeTruthy();
        expect(queryByTestId('stage-status')).toBeNull();
    });

    it('a stage-only operator (no Dev role) gets the stage and no Dev option', async () => {
        mockStages({ pipeline: { dev: null, stages: [UAT], releases: null } });
        const { findByTestId, queryByTestId } = render(
            <SolutionDetail project={{ id: 'p1', name: 'Quotes' }} onBack={() => {}} initialStage="uat" />,
        );
        expect(await findByTestId('stage-status')).toBeTruthy();
        expect(queryByTestId('stage-rail-dev')).toBeNull();
    });
});

describe('the Settings tab', () => {
    const DEV = { aheadOf: null, checks: { blocked: false, count: 0 } };
    const row = (stage, projectId) => ({
        stage, projectId, currentRelease: { id: 'rel_7', seq: 7 }, previousRelease: null, lastDeployment: null,
        pending: null, bindingsPending: false, enabled: true, role: 'owner',
    });
    const SETTINGS = {
        stage: 'uat', projectId: 'p_uat', settingsVersion: 2, enabled: true, paused: false, newPartsActive: true,
        runAs: { userId: 'u1', name: 'Olga' }, requiresApproval: false, approvalPolicy: null, rollbackNeedsApproval: false,
        bindingsPending: false, currentRelease: { id: 'rel_7', seq: 7 }, role: 'owner', parts: [], inbound: [],
    };
    function mockSettings() {
        globalThis.__authFetch = vi.fn(async (url) => {
            const ok = (body) => ({ ok: true, status: 200, json: async () => body });
            if (url.endsWith('/pipeline')) return ok({ dev: DEV, stages: [row('uat', 'p_uat'), row('prd', 'p_prd')], releases: [] });
            if (url.endsWith('/stages/uat')) return ok(SETTINGS);
            if (url.endsWith('/stages/uat/requirements')) return ok({ release: { id: 'rel_7', seq: 7 }, requirements: [] });
            if (url.endsWith('/stages/uat/variables')) return ok({ variables: [], values: [] });
            if (url.endsWith('/api/projects/p1/variables')) return ok({ variables: [] });
            if (url.includes('/resources')) return ok({ role: 'owner', notebooks: [], apps: [], automations: [], webpages: [], approvals: [] });
            if (url.includes('/graph')) return ok({ nodes: [], edges: [], externals: [], problems: [], unavailable: [], complete: true });
            if (url.includes('/completeness')) return ok(CLEAN);
            if (url.includes('/package/blueprints')) return ok({ blueprints: [] });
            if (url.includes('/members')) return ok({ ownerId: 'u1', members: [] });
            return ok({});
        });
    }
    const project = { id: 'p1', name: 'Quotes', permission: 'owner', installedFromBlueprintId: null, update: null };
    afterEach(() => window.history.replaceState(null, '', '/'));

    it('Settings is a tab on a stage, not on Dev', async () => {
        mockSettings();
        const user = userEvent.setup();
        const { findByRole, findByTestId, queryByRole } = render(<SolutionDetail project={project} onBack={() => {}} currentUserId="u1" />);
        await findByTestId('stage-rail');
        expect(queryByRole('radio', { name: /Settings/ })).toBeNull();
        await user.click(await findByTestId('stage-rail-uat'));
        await user.click(await findByRole('radio', { name: /Settings/ }));
        expect(await findByTestId('stage-settings')).toBeTruthy();
        // The settings of the STAGE are read, by the Dev id and the stage name.
        expect(globalThis.__authFetch.mock.calls.some(([u]) => String(u) === '/api/projects/p1/stages/uat')).toBe(true);
    });

    it('?tab=settings opens it, which is where the managed-part banners link to', async () => {
        mockSettings();
        window.history.replaceState(null, '', '/?stage=uat&tab=settings');
        const { findByTestId } = render(<SolutionDetail project={project} onBack={() => {}} currentUserId="u1" />);
        expect(await findByTestId('stage-settings')).toBeTruthy();
    });

    it('Dev has no stage settings, and its Pipeline tab hosts the variable declarations', async () => {
        mockSettings();
        const user = userEvent.setup();
        const { findByText, findByTestId, queryByTestId } = render(<SolutionDetail project={project} onBack={() => {}} currentUserId="u1" />);
        await user.click(await findByText('Pipeline'));
        expect(await findByTestId('variable-declarations')).toBeTruthy();
        expect(queryByTestId('stage-settings')).toBeNull();
    });
});
