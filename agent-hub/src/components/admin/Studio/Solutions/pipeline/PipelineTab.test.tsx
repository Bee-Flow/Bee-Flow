import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../../../utils/helpers', () => ({
    API_BASE: '',
    authFetch: (...args: unknown[]) => (globalThis as unknown as { __authFetch: (...a: unknown[]) => unknown }).__authFetch(...args),
}));

import PipelineTab from './PipelineTab';
import type { Pipeline, PipelineStage, Plan } from './stagesApi';

/**
 * The Pipeline tab in its three interesting states: no stages yet, Dev ahead of
 * the last release, and UAT ahead of Production. The fetch is mocked at the
 * wire (design section 8), so these tests pin what the tab SENDS as well.
 */

type Call = { url: string; method: string; body: Record<string, unknown> | null };
let calls: Call[] = [];

const ok = (body: unknown, status = 200) => ({ ok: true, status, json: async () => body });
const bad = (status: number, body: unknown) => ({ ok: false, status, json: async () => body });

const PLAN: Plan = {
    kind: 'deploy', stage: 'uat', release: { id: 'rel_1', seq: 1 }, from: null,
    parts: [{ ref: 'aut_1', kind: 'automation', name: 'Check VAT', action: 'create', goesLive: false }],
    data: [], referenceRows: [], knowledge: [],
    bindings: { missing: [], orphaned: [] }, variables: { missing: [], invalid: [], steeringPending: [] },
    readiness: [], blocking: [], gates: { approval: 'not_required' }, differsFromUat: [],
    acknowledgementsRequired: [], planHash: 'sha256:abc',
};

function wire(overrides: Record<string, (c: Call) => unknown> = {}) {
    calls = [];
    (globalThis as unknown as { __authFetch: unknown }).__authFetch = vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
        const call: Call = { url, method: init?.method || 'GET', body: init?.body ? JSON.parse(init.body) : null };
        calls.push(call);
        for (const [needle, handler] of Object.entries(overrides)) if (url.includes(needle)) return handler(call);
        if (url.endsWith('/plan')) return ok({ ...PLAN, stage: url.includes('/prd/') ? 'prd' : 'uat' });
        return ok({});
    });
}

const stage = (name: 'uat' | 'prd', over: Partial<PipelineStage> = {}): PipelineStage => ({
    stage: name, projectId: `p_${name}`, currentRelease: null, lastDeployment: null, pending: null,
    bindingsPending: false, enabled: true, role: 'owner', ...over,
});

const base = (over: Partial<Pipeline> = {}): Pipeline => ({
    dev: { aheadOf: null, checks: { blocked: false, count: 0 } }, stages: [stage('uat'), stage('prd')], releases: [], ...over,
});

function renderTab(pipeline: Pipeline | null, extra: Partial<React.ComponentProps<typeof PipelineTab>> = {}) {
    const onReload = vi.fn();
    const utils = render(
        <PipelineTab
            solutionId="sol1" solutionName="Onboarding" pipeline={pipeline} readState="ok" owner onReload={onReload}
            pollMs={20} {...extra}
        />,
    );
    return { ...utils, onReload };
}

beforeEach(() => wire());
afterEach(() => { delete (globalThis as unknown as { __authFetch?: unknown }).__authFetch; });

describe('no stages yet', () => {
    it('offers "Set up stages" and sends both stages with a request key', async () => {
        const user = userEvent.setup();
        const { onReload } = renderTab(base({ stages: [] }));
        expect(screen.getByTestId('pipeline-empty')).toBeTruthy();
        await user.click(screen.getByRole('button', { name: 'Set up stages' }));
        await waitFor(() => expect(onReload).toHaveBeenCalled());
        const post = calls.find(c => c.method === 'POST')!;
        expect(post.url).toBe('/api/projects/sol1/stages');
        expect(post.body).toMatchObject({ stages: ['uat', 'prd'] });
        expect(typeof post.body?.requestKey).toBe('string');
    });

    it('says why when stages could not be created', async () => {
        wire({ '/stages': () => bad(409, { code: 'stages_need_org', error: 'x' }) });
        const user = userEvent.setup();
        renderTab(base({ stages: [] }));
        await user.click(screen.getByRole('button', { name: 'Set up stages' }));
        expect((await screen.findByTestId('pipeline-problem')).getAttribute('data-kind')).toBe('stages_need_org');
    });

    it('a non-owner only reads about it', () => {
        renderTab(base({ stages: [] }), { owner: false });
        expect(screen.queryByRole('button', { name: 'Set up stages' })).toBeNull();
    });

    it('UNKNOWN IS NOT EMPTY: an unreadable pipeline never offers to set stages up', () => {
        render(<PipelineTab solutionId="sol1" solutionName="Onboarding" pipeline={null} readState="unreadable" owner onReload={() => {}} />);
        expect(screen.getByTestId('pipeline-read-problem').getAttribute('data-state')).toBe('unreadable');
        expect(screen.queryByTestId('pipeline-empty')).toBeNull();
        expect(screen.queryByRole('button', { name: 'Set up stages' })).toBeNull();
    });
});

describe('Dev is ahead', () => {
    const ahead = () => base({
        dev: { aheadOf: { seq: 1, changed: 2, added: 1, removed: 0 }, checks: { blocked: false, count: 0 } },
        releases: [{ id: 'rel_1', seq: 1, gate: { blocked: false } }],
    });

    it('cuts a release and opens the deploy dialog for UAT with it', async () => {
        wire({ '/releases': () => ok({ release: { id: 'rel_2', seq: 2 } }, 201) });
        const user = userEvent.setup();
        renderTab(ahead());
        expect(screen.getByTestId('pipeline-state-dev').textContent).toMatch(/2 changed · 1 added · 0 removed/);
        await user.click(screen.getByRole('button', { name: /Release & deploy to UAT/ }));
        expect(await screen.findByTestId('deploy-dialog')).toBeTruthy();
        const cut = calls.find(c => c.url.endsWith('/releases'))!;
        expect(cut.method).toBe('POST');
        const plan = calls.find(c => c.url.endsWith('/stages/uat/plan'))!;
        expect(plan.body).toMatchObject({ releaseId: 'rel_2' });
        expect(await screen.findByTestId('deploy-submit')).toBeTruthy();
    });

    it('a blocked cut lists what blocks it and opens nothing', async () => {
        wire({ '/releases': () => bad(409, { code: 'release_blocked', error: 'no', details: { findings: [{ code: 'x', message: 'Desk runs an automation of someone else.' }] } }) });
        const user = userEvent.setup();
        renderTab(ahead());
        await user.click(screen.getByRole('button', { name: /Release & deploy to UAT/ }));
        expect(await screen.findByText('Desk runs an automation of someone else.')).toBeTruthy();
        expect(screen.queryByTestId('deploy-dialog')).toBeNull();
    });

    it('blocked checks offer no release, only the way to the checks', async () => {
        const onOpenChecks = vi.fn();
        const user = userEvent.setup();
        renderTab(base({ dev: { aheadOf: { seq: 1, changed: 1, added: 0, removed: 0 }, checks: { blocked: true, count: 2 } }, releases: [{ id: 'rel_1', seq: 1 }] }), { onOpenChecks });
        expect(screen.queryByTestId('pipeline-primary-dev')).toBeNull();
        await user.click(screen.getByTestId('pipeline-open-checks'));
        expect(onOpenChecks).toHaveBeenCalled();
    });
});

describe('UAT is ahead of Production', () => {
    const promotable = () => base({
        stages: [
            stage('uat', { currentRelease: { id: 'rel_7', seq: 7 }, lastDeployment: { id: 'd7', status: 'succeeded', kind: 'deploy', releaseSeq: 7 } }),
            stage('prd', { currentRelease: { id: 'rel_5', seq: 5 }, previousRelease: { id: 'rel_4', seq: 4 } }),
        ],
        releases: [{ id: 'rel_7', seq: 7 }, { id: 'rel_5', seq: 5 }, { id: 'rel_4', seq: 4 }],
    });

    it('promote opens the dialog on the production plan of that release', async () => {
        const user = userEvent.setup();
        renderTab(promotable());
        expect(screen.getByTestId('pipeline-release-uat').textContent).toBe('R7');
        expect(screen.getByTestId('pipeline-release-prd').textContent).toBe('R5');
        await user.click(screen.getByRole('button', { name: /Promote R7 to Production/ }));
        expect(await screen.findByTestId('deploy-dialog')).toBeTruthy();
        const plan = calls.find(c => c.url.endsWith('/stages/prd/plan'))!;
        expect(plan.body).toMatchObject({ releaseId: 'rel_7', kind: 'deploy' });
    });

    it('offers a rollback to the release before', async () => {
        const user = userEvent.setup();
        renderTab(promotable());
        await user.click(screen.getByRole('button', { name: /Roll back to R4/ }));
        await screen.findByTestId('deploy-dialog');
        expect(calls.find(c => c.url.endsWith('/stages/prd/plan'))!.body).toMatchObject({ releaseId: 'rel_4', kind: 'rollback' });
    });

    it('offers the rollback with the number looked up when the server sends the id only', async () => {
        const user = userEvent.setup();
        const p = promotable();
        p.stages[1] = { ...p.stages[1], previousRelease: { id: 'rel_4', seq: null } };
        renderTab(p);
        await user.click(screen.getByRole('button', { name: /Roll back to R4/ }));
        await screen.findByTestId('deploy-dialog');
        expect(calls.find(c => c.url.endsWith('/stages/prd/plan'))!.body).toMatchObject({ releaseId: 'rel_4', kind: 'rollback' });
    });

    it('keeps a usable rollback label when the number cannot be found', () => {
        const p = promotable();
        p.stages[1] = { ...p.stages[1], previousRelease: { id: 'rel_gone', seq: null } };
        renderTab(p);
        expect(screen.getByRole('button', { name: /Roll back to the previous release/ })).toBeTruthy();
    });

    it('with the gate on the button asks for approval instead', () => {
        const p = promotable();
        p.stages[1] = { ...p.stages[1], requiresApproval: true };
        renderTab(p);
        expect(screen.getByRole('button', { name: /Request approval for R7/ })).toBeTruthy();
    });

    it('a request waiting for approval can be cancelled by the owner', async () => {
        const p = promotable();
        p.stages[1] = { ...p.stages[1], pending: { id: 'dp', status: 'awaiting_approval', kind: 'deploy', releaseSeq: 7 } };
        const user = userEvent.setup();
        const { onReload } = renderTab(p);
        expect(screen.getByTestId('pipeline-column-prd').getAttribute('data-state')).toBe('awaiting_approval');
        await user.click(screen.getByTestId('pipeline-secondary-cancel_request'));
        await waitFor(() => expect(onReload).toHaveBeenCalled());
        expect(calls.find(c => c.url.endsWith('/deployments/dp/cancel'))!.method).toBe('POST');
    });

    it('lists the releases and where each one runs', () => {
        renderTab(promotable());
        const rows = screen.getAllByTestId('pipeline-release-row').map(r => r.textContent);
        expect(rows[0]).toMatch(/Release 7.*Running in UAT/);
        expect(rows[1]).toMatch(/Release 5.*Running in Production/);
    });

    it('re-reads the pipeline while a deployment runs', async () => {
        const p = promotable();
        p.stages[0] = { ...p.stages[0], lastDeployment: { id: 'd8', status: 'committing', kind: 'deploy', releaseSeq: 8 } };
        const { onReload } = renderTab(p);
        expect(screen.getByTestId('pipeline-progress').textContent).toMatch(/Switching/);
        await waitFor(() => expect(onReload).toHaveBeenCalled());
    });
});
