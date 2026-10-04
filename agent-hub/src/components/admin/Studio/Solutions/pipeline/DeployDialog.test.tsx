import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../../../utils/helpers', () => ({
    API_BASE: '',
    authFetch: (...args: unknown[]) => (globalThis as unknown as { __authFetch: (...a: unknown[]) => unknown }).__authFetch(...args),
}));

import DeployDialog, { type DeployRequest } from './DeployDialog';
import type { Plan } from './stagesApi';

/**
 * The deploy dialog: an acknowledgement is required, a stale plan is re-planned
 * (not apologised for), Production asks for the Solution's name, and what the
 * plan says about steering values and missing settings is on screen before
 * anything is sent.
 */

type Call = { url: string; method: string; body: Record<string, any> | null };
let calls: Call[] = [];

const ok = (body: unknown, status = 200) => ({ ok: true, status, json: async () => body });
const bad = (status: number, body: unknown) => ({ ok: false, status, json: async () => body });

const plan = (over: Partial<Plan> = {}): Plan => ({
    kind: 'deploy', stage: 'uat', release: { id: 'rel_7', seq: 7 }, from: { releaseId: 'rel_5', seq: 5 },
    parts: [
        { ref: 'aut_1', kind: 'automation', name: 'Check VAT', action: 'replace', summary: "Adds a step 'Check VAT'", goesLive: true },
        { ref: 'app_1', kind: 'app', name: 'Desk', action: 'unchanged' },
    ],
    data: [], referenceRows: [], knowledge: [],
    bindings: { missing: [], orphaned: [] }, variables: { missing: [], invalid: [], steeringPending: [] },
    readiness: [], blocking: [], gates: { approval: 'not_required' }, differsFromUat: [],
    acknowledgementsRequired: [], planHash: 'sha256:one', ...over,
});

let planQueue: Plan[] = [];
let deployHandler: (c: Call) => unknown = () => ok({ deployment: { id: 'dep1', status: 'queued', kind: 'deploy' } }, 202);
let deploymentStates: string[] = [];

function wire() {
    calls = [];
    (globalThis as unknown as { __authFetch: unknown }).__authFetch = vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
        const call: Call = { url, method: init?.method || 'GET', body: init?.body ? JSON.parse(init.body) : null };
        calls.push(call);
        if (url.endsWith('/plan')) return ok(planQueue.length > 1 ? planQueue.shift() : planQueue[0]);
        if (url.endsWith('/deployments') && call.method === 'POST') return deployHandler(call);
        if (url.includes('/deployments/dep1')) {
            const status = deploymentStates.length > 1 ? deploymentStates.shift() : deploymentStates[0];
            return ok({ deployment: { id: 'dep1', status, kind: 'deploy', error: status === 'failed' ? { message: 'The automation could not be switched on.' } : null } });
        }
        return ok({});
    });
}

const UAT: DeployRequest = { stage: 'uat', kind: 'deploy', releaseId: 'rel_7', releaseSeq: 7 };
const PRD: DeployRequest = { stage: 'prd', kind: 'deploy', releaseId: 'rel_7', releaseSeq: 7 };

function renderDialog(request: DeployRequest = UAT, extra: Partial<React.ComponentProps<typeof DeployDialog>> = {}) {
    const onClose = vi.fn();
    render(<DeployDialog open solutionId="sol1" solutionName="Onboarding" request={request} onClose={onClose} pollMs={10} {...extra} />);
    return { onClose };
}

beforeEach(() => {
    planQueue = [plan()];
    deployHandler = () => ok({ deployment: { id: 'dep1', status: 'queued', kind: 'deploy' } }, 202);
    deploymentStates = ['preparing', 'committing', 'succeeded'];
    wire();
});
afterEach(() => { delete (globalThis as unknown as { __authFetch?: unknown }).__authFetch; });

const submitButton = () => screen.findByTestId('deploy-submit') as Promise<HTMLButtonElement>;

describe('what the plan shows', () => {
    it('lists the changes, folds the unchanged ones into a count and names the outcome', async () => {
        renderDialog();
        const btn = await submitButton();
        expect(btn.textContent).toBe('Deploy R7 to UAT');
        expect(screen.getAllByTestId('deploy-part')).toHaveLength(1);
        expect(screen.getByText('Check VAT')).toBeTruthy();
        expect(screen.getByText('1 parts stay as they are.')).toBeTruthy();
        expect(btn.disabled).toBe(false);
        expect(calls[0].body).toMatchObject({ releaseId: 'rel_7', kind: 'deploy' });
    });

    it('shows steering values that apply with this deployment', async () => {
        planQueue = [plan({ variables: { missing: [], invalid: [], steeringPending: ['report_email'] } })];
        renderDialog();
        await submitButton();
        expect(screen.getByTestId('deploy-section-steering')).toBeTruthy();
        expect(screen.getByTestId('deploy-steering').textContent).toBe('report_email');
    });

    it('missing settings keep the button off and link to the stage settings', async () => {
        planQueue = [plan({ bindings: { missing: [{ slot: 'connection:cn_1', label: 'Mail account' }], orphaned: [] } })];
        const onOpenSettings = vi.fn();
        const user = userEvent.setup();
        renderDialog(UAT, { onOpenSettings });
        expect((await submitButton()).disabled).toBe(true);
        expect(screen.getByTestId('deploy-missing').textContent).toBe('Mail account');
        expect(screen.getByTestId('deploy-block-hint').textContent).toMatch(/missing settings/);
        const link = screen.getByTestId('deploy-open-settings');
        expect(link.getAttribute('href')).toBe('?stage=uat&tab=settings');
        await user.click(link);
        expect(onOpenSettings).toHaveBeenCalledWith('uat');
    });

    it('blocking findings are listed and block', async () => {
        planQueue = [plan({ blocking: [{ code: 'app.data_model_not_additive', message: 'Desk drops a field.' }] })];
        renderDialog();
        expect((await submitButton()).disabled).toBe(true);
        expect(screen.getByText('Desk drops a field.')).toBeTruthy();
    });

    it('says when constraints are relaxed because a column is retired', async () => {
        planQueue = [plan({
            data: [{ ref: 'dt_1', name: 'Quotes', add: ['vat'], rename: [], unretire: [], blocked: [], retire: [{ key: 'legacy', relaxes: { notNull: true } }] }],
            acknowledgementsRequired: [{ code: 'schema.retire_column', ref: 'dt_1' }],
        })];
        renderDialog();
        await submitButton();
        expect(screen.getByTestId('deploy-retire').textContent).toMatch(/Retires column legacy.*relaxed/);
    });

    it('Production lists the differences from UAT and the approval it needs', async () => {
        planQueue = [plan({ stage: 'prd', gates: { approval: 'required' }, differsFromUat: [{ kind: 'binding', label: 'connection:cn_1', uat: 'a', prd: 'b' }] })];
        renderDialog(PRD);
        const btn = await submitButton();
        expect(btn.textContent).toBe('Request approval for R7');
        expect(screen.getByTestId('deploy-differs').textContent).toBe('connection:cn_1');
        expect(screen.getByTestId('deploy-approval').textContent).toMatch(/needs approval/);
    });
});

describe('acknowledgements', () => {
    const withKb = () => plan({
        knowledge: [{ ref: 'kb_1', copy: 4, remove: 0, unchanged: 2, personalDataFlagged: 1, sourceStage: 'dev' }],
        parts: [{ ref: 'kb_1', kind: 'knowledge_base', name: 'Handbook', action: 'replace' }],
        acknowledgementsRequired: [{ code: 'kb.personal_data', ref: 'kb_1' }],
    });

    it('an ack is required: off until ticked, sent with its ref once ticked', async () => {
        planQueue = [withKb()];
        const user = userEvent.setup();
        renderDialog();
        const btn = await submitButton();
        expect(btn.disabled).toBe(true);
        expect(screen.getByTestId('deploy-block-hint').textContent).toMatch(/Tick every box/);
        await user.click(screen.getByRole('checkbox', { name: /Handbook may contain personal data/ }));
        expect(btn.disabled).toBe(false);
        await user.click(btn);
        const post = calls.find(c => c.method === 'POST' && c.url.endsWith('/deployments'))!;
        expect(post.body?.acknowledgements).toEqual([{ code: 'kb.personal_data', ref: 'kb_1' }]);
        expect(post.body).toMatchObject({ releaseId: 'rel_7', kind: 'deploy', planHash: 'sha256:one' });
        expect(typeof post.body?.requestKey).toBe('string');
    });

    it('a 409 acknowledgement_missing marks the box the server named', async () => {
        planQueue = [withKb()];
        deployHandler = () => bad(409, { code: 'acknowledgement_missing', error: 'x', details: { missing: [{ code: 'kb.personal_data', ref: 'kb_1' }] } });
        const user = userEvent.setup();
        renderDialog();
        await user.click(await screen.findByRole('checkbox'));
        await user.click(await submitButton());
        expect((await screen.findByTestId('deploy-problem')).getAttribute('data-kind')).toBe('acknowledgement_missing');
        expect(screen.getByRole('checkbox').closest('label')!.className).toMatch(/ring-1/);
    });
});

describe('a plan that went stale', () => {
    it('409 plan_stale swaps in the plan the server sent, clears the ticks and keeps the request key', async () => {
        const stale = plan({
            planHash: 'sha256:one',
            knowledge: [{ ref: 'kb_1', copy: 1, remove: 0, unchanged: 0, personalDataFlagged: 1 }],
            acknowledgementsRequired: [{ code: 'kb.personal_data', ref: 'kb_1' }],
        });
        const fresh = plan({
            planHash: 'sha256:two',
            parts: [{ ref: 'aut_2', kind: 'automation', name: 'Send reminder', action: 'create' }],
            knowledge: [{ ref: 'kb_1', copy: 2, remove: 0, unchanged: 0, personalDataFlagged: 1 }],
            acknowledgementsRequired: [{ code: 'kb.personal_data', ref: 'kb_1' }],
        });
        planQueue = [stale];
        let attempt = 0;
        deployHandler = () => (++attempt === 1
            ? bad(409, { code: 'plan_stale', error: 'x', details: { plan: fresh } })
            : ok({ deployment: { id: 'dep1', status: 'queued', kind: 'deploy' } }, 202));
        const user = userEvent.setup();
        renderDialog();
        await user.click(await screen.findByRole('checkbox'));
        await user.click(await submitButton());

        expect(await screen.findByTestId('deploy-replanned')).toBeTruthy();
        expect(screen.getByText('Send reminder')).toBeTruthy();
        const box = screen.getByRole('checkbox') as HTMLInputElement;
        expect(box.checked).toBe(false);
        expect((await submitButton()).disabled).toBe(true);

        await user.click(box);
        await user.click(await submitButton());
        const posts = calls.filter(c => c.method === 'POST' && c.url.endsWith('/deployments'));
        expect(posts).toHaveLength(2);
        expect(posts[0].body?.planHash).toBe('sha256:one');
        expect(posts[1].body?.planHash).toBe('sha256:two');
        expect(posts[1].body?.requestKey).toBe(posts[0].body?.requestKey);
    });

    it('without a plan in the body the dialog plans again', async () => {
        planQueue = [plan({ planHash: 'sha256:one' }), plan({ planHash: 'sha256:two' })];
        let attempt = 0;
        deployHandler = () => (++attempt === 1
            ? bad(409, { code: 'plan_stale', error: 'x' })
            : ok({ deployment: { id: 'dep1', status: 'queued', kind: 'deploy' } }, 202));
        const user = userEvent.setup();
        renderDialog();
        await user.click(await submitButton());
        await screen.findByTestId('deploy-replanned');
        await user.click(await submitButton());
        const posts = calls.filter(c => c.method === 'POST' && c.url.endsWith('/deployments'));
        expect(posts.map(p => p.body?.planHash)).toEqual(['sha256:one', 'sha256:two']);
        expect(calls.filter(c => c.url.endsWith('/plan'))).toHaveLength(2);
    });
});

describe('Production asks for the name', () => {
    it('the button stays off until the Solution name is typed exactly', async () => {
        planQueue = [plan({ stage: 'prd' })];
        const user = userEvent.setup();
        renderDialog(PRD);
        const btn = await submitButton();
        expect(btn.textContent).toBe('Promote R7 to Production');
        expect(btn.disabled).toBe(true);
        expect(screen.getByTestId('deploy-block-hint').textContent).toMatch(/Type the name/);
        const input = screen.getByTestId('deploy-confirm-name');
        await user.type(input, 'Onboardin');
        expect(btn.disabled).toBe(true);
        await user.type(input, 'g');
        expect(btn.disabled).toBe(false);
    });

    it('UAT does not ask', async () => {
        renderDialog(UAT);
        await submitButton();
        expect(screen.queryByTestId('deploy-confirm-name')).toBeNull();
    });
});

describe('progress', () => {
    it('follows the deployment until it is done, polling', async () => {
        const user = userEvent.setup();
        const { onClose } = renderDialog();
        await user.click(await submitButton());
        expect(await screen.findByTestId('deploy-tracking')).toBeTruthy();
        await waitFor(() => expect(screen.getByTestId('deploy-tracking').getAttribute('data-status')).toBe('succeeded'));
        expect(screen.getByTestId('deploy-outcome').textContent).toBe('Release 7 is live in UAT.');
        expect(calls.filter(c => c.url.endsWith('/deployments/dep1')).length).toBeGreaterThanOrEqual(2);
        await user.click(screen.getByTestId('deploy-close'));
        expect(onClose).toHaveBeenCalled();
    });

    it('a failed deployment says nothing changed', async () => {
        deploymentStates = ['failed'];
        const user = userEvent.setup();
        renderDialog();
        await user.click(await submitButton());
        await waitFor(() => expect(screen.getByTestId('deploy-tracking').getAttribute('data-status')).toBe('failed'));
        expect(screen.getByTestId('deploy-outcome').textContent).toMatch(/Nothing changed in UAT\. The automation could not be switched on\./);
    });

    it('a request for approval waits and says nothing changed', async () => {
        planQueue = [plan({ stage: 'prd', gates: { approval: 'required' } })];
        deployHandler = () => ok({ deployment: { id: 'dep1', status: 'awaiting_approval', kind: 'deploy' } }, 202);
        deploymentStates = ['awaiting_approval'];
        const user = userEvent.setup();
        renderDialog(PRD);
        await user.type(await screen.findByTestId('deploy-confirm-name'), 'Onboarding');
        await user.click(await submitButton());
        expect((await screen.findByTestId('deploy-outcome')).textContent).toMatch(/Requested\. Production changes once it is approved/);
    });

    it('a plan that cannot be made says why instead of showing an empty dialog', async () => {
        (globalThis as unknown as { __authFetch: unknown }).__authFetch = vi.fn(async () => bad(409, { code: 'release_not_in_uat', error: 'x' }));
        renderDialog(PRD);
        expect((await screen.findByTestId('deploy-problem')).getAttribute('data-kind')).toBe('release_not_in_uat');
        expect(screen.getByTestId('deploy-submit')).toBeTruthy();
        expect((screen.getByTestId('deploy-submit') as HTMLButtonElement).disabled).toBe(true);
    });
});
