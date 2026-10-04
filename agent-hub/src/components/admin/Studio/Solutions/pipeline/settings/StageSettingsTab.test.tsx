import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../../../../utils/helpers', () => ({
    API_BASE: '',
    authFetch: (...args: unknown[]) => (globalThis as unknown as { __authFetch: (...a: unknown[]) => unknown }).__authFetch(...args),
}));
vi.mock('../../../../../licensing/LicenseContext', () => ({
    useLicenseContext: () => (globalThis as unknown as { __lic: unknown }).__lic,
}));
// The members dialog belongs to the project workspace and has its own tests; here it only has to receive the STAGE's project.
vi.mock('../../SolutionAccessDialog', () => ({
    default: ({ open, projectId, role }: { open: boolean; projectId: string; role: string }) => (open ? <div data-testid="access-dialog">{`${projectId}:${role}`}</div> : null),
}));

import StageSettingsTab from './StageSettingsTab';
import VariablesDeclarations from './VariablesDeclarations';
import type { PipelineStage, StageKey } from '../stagesApi';

type Call = { url: string; method: string; body: Record<string, unknown> | null };
type Handler = (c: Call) => unknown;
let calls: Call[] = [];

const ok = (body: unknown, status = 200) => ({ ok: true, status, json: async () => body });
const bad = (status: number, body: unknown) => ({ ok: false, status, json: async () => body });

const SETTINGS = (over: Record<string, unknown> = {}) => ({
    stage: 'uat', projectId: 'p_uat', solutionId: 'sol1', settingsVersion: 3, enabled: true, paused: false, newPartsActive: true,
    runAs: { userId: 'u_owner', name: 'Olga Owner' }, requiresApproval: false, approvalPolicy: null, rollbackNeedsApproval: false,
    bindingsPending: false, currentRelease: { id: 'rel_2', seq: 2 }, role: 'owner',
    parts: [
        { ref: 'aut_1', kind: 'automation', name: 'Check VAT', entityId: 'e1', active: true, retired: false, drift: false },
        { ref: 'app_1', kind: 'app', name: 'Desk', entityId: 'e2', active: false, retired: false, drift: true },
        { ref: 'tab_1', kind: 'datatable', name: 'Orders', entityId: 'e3', active: null, retired: false, drift: false },
    ],
    inbound: [{ kind: 'webhook', label: 'Check VAT', url: 'https://x.example/webhook/abc' }],
    ...over,
});

const REQUIREMENTS = {
    release: { id: 'rel_2', seq: 2 },
    requirements: [
        { slot: 'connection:cn_1', kind: 'connection', label: 'Connection for this request', neededBy: ['aut_1'], bound: false, suggested: { connectionId: 'c_dev', allowedHosts: ['api.dev.example'] }, binding: null },
        { slot: 'seats:aut_1:s_approve', kind: 'approver_seats', label: 'Who approves', neededBy: ['aut_1'], bound: false, suggested: { assignee: { userId: 'u_dev' } }, binding: null },
        { slot: 'notify:aut_1', kind: 'approver_seats', label: 'Who is notified', neededBy: ['aut_1'], bound: true, suggested: null, binding: { onError: { recipients: [{ type: 'user', id: 'u2' }] } } },
        { slot: 'table:orders', kind: 'table', label: 'Table "orders"', neededBy: ['aut_1'], bound: false, suggested: { datatableId: 'dt_dev' }, binding: null },
    ],
};

const VARIABLES = {
    stage: 'uat', bindingsPending: false,
    variables: [
        { name: 'tax_rate', type: 'number', choices: null, description: 'VAT percentage', required: true, steering: false },
        { name: 'report_to', type: 'email', choices: null, description: 'Where the weekly report goes', required: true, steering: true },
    ],
    values: [{ name: 'tax_rate', value: 21, appliedValue: 21, updatedAt: null }],
};

const PLAN = {
    kind: 'redeploy', stage: 'uat', release: { id: 'rel_2', seq: 2 }, from: null, parts: [], data: [], referenceRows: [], knowledge: [],
    bindings: { missing: [], orphaned: [] }, variables: { missing: [], invalid: [], steeringPending: [] }, readiness: [], blocking: [],
    gates: { approval: 'not_required' }, differsFromUat: [], acknowledgementsRequired: [], planHash: 'sha256:abc',
};

function wire(over: { settings?: Record<string, unknown>; handlers?: Record<string, Handler> } = {}) {
    calls = [];
    (globalThis as unknown as { __authFetch: unknown }).__authFetch = vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
        const call: Call = { url, method: init?.method || 'GET', body: init?.body ? JSON.parse(init.body) : null };
        calls.push(call);
        for (const [needle, handler] of Object.entries(over.handlers || {})) {
            const [method, part] = needle.includes(' ') ? needle.split(' ') : ['GET', needle];
            if (call.method === method && url.includes(part)) return handler(call);
        }
        const stage = url.includes('/stages/prd') ? 'prd' : 'uat';
        if (call.method === 'GET' && /\/stages\/(uat|prd)$/.test(url)) return ok(SETTINGS({ stage, projectId: `p_${stage}`, ...(over.settings || {}) }));
        if (call.method === 'GET' && url.split('?')[0].endsWith('/requirements')) return ok(REQUIREMENTS);
        if (call.method === 'GET' && url.endsWith('/variables')) return ok(VARIABLES);
        if (url.includes('/approvals/directory')) return ok({ members: [{ id: 'u_owner', name: 'Olga Owner' }, { id: 'u2', name: 'Pim' }], groups: [{ id: 'g1', name: 'Finance' }] });
        if (url.includes('/integrations/connections')) return ok({ connections: [{ id: 'c_prd', label: 'Prod API', kind: 'bearer' }] });
        if (url.endsWith('/plan')) return ok(PLAN);
        return ok({});
    });
}

const row = (stage: StageKey, over: Partial<PipelineStage> = {}): PipelineStage => ({
    stage, projectId: `p_${stage}`, currentRelease: { id: 'rel_2', seq: 2 }, lastDeployment: null, pending: null, bindingsPending: false, enabled: true, role: 'owner', ...over,
});

function renderTab(stage: StageKey = 'uat', props: Partial<React.ComponentProps<typeof StageSettingsTab>> = {}) {
    const onChanged = vi.fn();
    render(<StageSettingsTab solutionId="sol1" solutionName="Onboarding" stage={stage} stageRow={row(stage)} currentUserId="u_owner" onChanged={onChanged} {...props} />);
    return { onChanged };
}

const writes = () => calls.filter(c => c.method !== 'GET' && !c.url.endsWith('/plan'));

beforeEach(() => { (globalThis as unknown as { __lic: unknown }).__lic = { hasFeature: () => true, entDegraded: false, entError: null }; wire(); });
afterEach(() => { vi.restoreAllMocks(); });

describe('loading', () => {
    it('reads the stage, what it needs and its variables, and shows each section', async () => {
        renderTab();
        expect(await screen.findByTestId('stage-settings')).toBeTruthy();
        expect(await screen.findByTestId('binding-connection:cn_1')).toBeTruthy();
        expect(calls.some(c => c.url === '/api/projects/sol1/stages/uat')).toBe(true);
        expect(calls.some(c => c.url.startsWith('/api/projects/sol1/stages/uat/requirements'))).toBe(true);
        expect(calls.some(c => c.url === '/api/projects/sol1/stages/uat/variables')).toBe(true);
        // Bindings are grouped by kind and say who needs them.
        for (const g of ['connections', 'approvers', 'notify', 'data']) expect(screen.getByTestId(`bindings-group-${g}`)).toBeTruthy();
        expect(within(screen.getByTestId('binding-table:orders')).getByText(/Needed by Check VAT/)).toBeTruthy();
        expect(screen.getByTestId('access-run-as').textContent).toMatch(/Olga Owner/);
        expect(screen.getByTestId('part-aut_1')).toBeTruthy();
        expect(screen.getByTestId('block-danger')).toBeTruthy();
    });

    it('a settings read that failed says so instead of showing an empty page', async () => {
        wire({ handlers: { 'GET /stages/uat': () => bad(500, { error: 'boom' }) } });
        // The generic route handler would answer the sub-paths; only the bare settings read fails.
        renderTab();
        expect(await screen.findByTestId('stage-settings-unreadable')).toBeTruthy();
        expect(screen.queryByTestId('stage-settings')).toBeNull();
    });

    it('a requirements read that failed is not "nothing needed"', async () => {
        wire({ handlers: { 'GET /requirements': () => bad(500, { error: 'boom' }) } });
        renderTab();
        expect(await screen.findByTestId('bindings-unreadable')).toBeTruthy();
        expect(screen.queryByTestId('bindings-none')).toBeNull();
    });

    it('a stage editor sees whether a slot is set but not its value, and cannot edit it', async () => {
        wire({
            settings: { role: 'editor' },
            handlers: { 'GET /requirements': () => ok({ release: { id: 'r', seq: 2 }, requirements: [{ slot: 'table:orders', kind: 'table', label: 'Table "orders"', neededBy: [], bound: true }] }) },
        });
        renderTab('uat', { stageRow: row('uat', { role: 'editor' }) });
        const card = await screen.findByTestId('binding-table:orders');
        expect(card.getAttribute('data-status')).toBe('bound');
        expect(within(card).queryByRole('textbox')).toBeNull();
        expect(screen.queryByTestId('bindings-save')).toBeNull();
    });
});

describe('bindings', () => {
    it('"use the same as Dev" is one deliberate click, and saving sends the settings version', async () => {
        const user = userEvent.setup();
        const { onChanged } = renderTab();
        const card = await screen.findByTestId('binding-table:orders');
        await user.click(within(card).getByText('Use the same as Dev'));
        expect((within(card).getByRole('textbox') as HTMLInputElement).value).toBe('dt_dev');
        expect(card.getAttribute('data-status')).toBe('changed');
        expect(writes()).toHaveLength(0);          // never implicit
        await user.click(screen.getByTestId('bindings-save'));
        await waitFor(() => expect(writes()).toHaveLength(1));
        expect(writes()[0]).toMatchObject({ method: 'PUT', url: '/api/projects/sol1/stages/uat/bindings', body: { settingsVersion: 3, bindings: [{ slot: 'table:orders', value: { datatableId: 'dt_dev' } }] } });
        await waitFor(() => expect(onChanged).toHaveBeenCalled());
    });

    it('a Production connection without allowed hosts cannot be saved, and says why', async () => {
        wire({ settings: { stage: 'prd' } });
        const user = userEvent.setup();
        renderTab('prd');
        const card = await screen.findByTestId('binding-connection:cn_1');
        await user.selectOptions(within(card).getByLabelText('Connection'), 'c_prd');
        expect(within(card).getByTestId('binding-problem-connection:cn_1').textContent).toMatch(/at least one allowed host/);
        expect((screen.getByTestId('bindings-save') as HTMLButtonElement).disabled).toBe(true);
        await user.type(within(card).getByLabelText(/Allowed hosts/), 'api.example.com');
        expect(within(card).queryByTestId('binding-problem-connection:cn_1')).toBeNull();
        await user.click(screen.getByTestId('bindings-save'));
        await waitFor(() => expect(writes()).toHaveLength(1));
        expect(writes()[0].body).toMatchObject({ bindings: [{ slot: 'connection:cn_1', value: { connectionId: 'c_prd', allowedHosts: ['api.example.com'] } }] });
    });

    it('the approver seats take the whole shape: a panel, a rule and an escalation', async () => {
        const user = userEvent.setup();
        renderTab();
        const card = await screen.findByTestId('binding-seats:aut_1:s_approve');
        await user.selectOptions(within(card).getByLabelText('Who decides'), 'u:u2');
        await user.click(within(card).getByText(/Add a panel member/));
        await user.selectOptions(within(card).getByLabelText('Panel member 1'), 'g:g1');
        await user.selectOptions(within(card).getByLabelText('Escalate to'), 'u:u_owner');
        await user.click(screen.getByTestId('bindings-save'));
        await waitFor(() => expect(writes()).toHaveLength(1));
        expect((writes()[0].body as { bindings: unknown[] }).bindings).toEqual([
            { slot: 'seats:aut_1:s_approve', value: { assignee: { userId: 'u2' }, escalateTo: { userId: 'u_owner' }, approvers: [{ groupId: 'g1' }] } },
        ]);
    });

    it('a 409 settings_stale shows the notice, reads the page again and keeps the edit', async () => {
        wire({ handlers: { 'PUT /bindings': () => bad(409, { error: 'changed', code: 'settings_stale', details: { settingsVersion: 4 } }) } });
        const user = userEvent.setup();
        renderTab();
        const card = await screen.findByTestId('binding-table:orders');
        await user.type(within(card).getByRole('textbox'), 'dt_mine');
        const readsBefore = calls.filter(c => c.url === '/api/projects/sol1/stages/uat').length;
        await user.click(screen.getByTestId('bindings-save'));
        expect(await screen.findByTestId('settings-stale')).toBeTruthy();
        await waitFor(() => expect(calls.filter(c => c.url === '/api/projects/sol1/stages/uat').length).toBeGreaterThan(readsBefore));
        expect((within(screen.getByTestId('binding-table:orders')).getByRole('textbox') as HTMLInputElement).value).toBe('dt_mine');
    });

    it('a refused binding is shown on its own slot', async () => {
        wire({ handlers: { 'PUT /bindings': () => bad(400, { error: 'x', code: 'binding_invalid', details: { slot: 'table:orders', why: 'other_stage' } }) } });
        const user = userEvent.setup();
        renderTab();
        const card = await screen.findByTestId('binding-table:orders');
        await user.type(within(card).getByRole('textbox'), 'dt_prd');
        await user.click(screen.getByTestId('bindings-save'));
        expect((await screen.findByTestId('binding-refused-table:orders')).textContent).toMatch(/another stage/);
    });

    it('Apply settings opens the redeploy dialog; Production with the gate on says it needs approval', async () => {
        wire({ settings: { stage: 'prd', bindingsPending: true, requiresApproval: true, approvalPolicy: { stages: [{ key: 's1', approvers: [{ userId: 'u2' }] }] } } });
        const user = userEvent.setup();
        renderTab('prd');
        expect((await screen.findByTestId('apply-needs-approval')).textContent).toMatch(/approvers/);
        await user.click(screen.getByTestId('apply-settings'));
        await waitFor(() => expect(calls.some(c => c.url === '/api/projects/sol1/stages/prd/plan')).toBe(true));
        expect(calls.find(c => c.url.endsWith('/plan'))?.body).toMatchObject({ releaseId: 'rel_2', kind: 'redeploy' });
    });

    it('UAT apply carries no approval warning', async () => {
        wire({ settings: { bindingsPending: true } });
        renderTab('uat');
        await screen.findByTestId('apply-settings');
        expect(screen.queryByTestId('apply-needs-approval')).toBeNull();
    });
});

describe('variables', () => {
    it('marks steering variables and disables them for a stage editor, with the reason', async () => {
        wire({ settings: { role: 'editor' } });
        renderTab('uat', { stageRow: row('uat', { role: 'editor' }) });
        const steering = await screen.findByTestId('variable-report_to');
        expect(steering.getAttribute('data-steering')).toBe('true');
        expect((within(steering).getByRole('textbox') as HTMLInputElement).disabled).toBe(true);
        expect(screen.getByTestId('variable-locked-report_to')).toBeTruthy();
        expect((within(screen.getByTestId('variable-tax_rate')).getByRole('spinbutton') as HTMLInputElement).disabled).toBe(false);
    });

    it('a steering edit by the owner is saved and says it applies on the next redeploy', async () => {
        const user = userEvent.setup();
        renderTab();
        const steering = await screen.findByTestId('variable-report_to');
        await user.type(within(steering).getByRole('textbox'), 'ops@example.com');
        expect(screen.getByTestId('variable-pending-report_to').textContent).toMatch(/next redeploy/);
        await user.click(screen.getByTestId('variables-save'));
        await waitFor(() => expect(writes()).toHaveLength(1));
        expect(writes()[0]).toMatchObject({ method: 'PUT', url: '/api/projects/sol1/stages/uat/variables', body: { values: { report_to: 'ops@example.com' } } });
    });

    it('a number is sent as a number', async () => {
        const user = userEvent.setup();
        renderTab();
        const input = within(await screen.findByTestId('variable-tax_rate')).getByRole('spinbutton');
        await user.clear(input);
        await user.type(input, '9');
        await user.click(screen.getByTestId('variables-save'));
        await waitFor(() => expect(writes()).toHaveLength(1));
        expect(writes()[0].body).toEqual({ values: { tax_rate: 9 } });
    });
});

describe('addresses, access, parts', () => {
    it('lists the addresses with a copy button', async () => {
        const user = userEvent.setup();
        renderTab();
        const row_ = await screen.findByTestId('address-row');
        expect(row_.textContent).toMatch(/webhook\/abc/);
        await user.click(within(row_).getByLabelText('Copy address'));
        expect(await navigator.clipboard.readText()).toBe('https://x.example/webhook/abc');
    });

    it('an editor is told webhooks are hidden from them rather than shown a list that looks complete', async () => {
        wire({ settings: { role: 'editor', inbound: [] } });
        renderTab('uat', { stageRow: row('uat', { role: 'editor' }) });
        expect(await screen.findByTestId('addresses-webhooks-hidden')).toBeTruthy();
    });

    it('opens the members dialog on the STAGE project, with run-as read-only', async () => {
        const user = userEvent.setup();
        renderTab();
        await user.click(await screen.findByTestId('access-open'));
        expect(screen.getByTestId('access-dialog').textContent).toBe('p_uat:owner');
        expect(within(screen.getByTestId('access-run-as')).queryByRole('textbox')).toBeNull();
    });

    it('switching a part sends active, and a part that was never deployed is explained on its own row', async () => {
        wire({ handlers: { 'PATCH /parts/app_1': () => bad(409, { error: 'not deployed', code: 'managed_part_not_deployed' }) } });
        const user = userEvent.setup();
        renderTab();
        await user.click(await screen.findByTestId('part-switch-aut_1'));
        await waitFor(() => expect(writes()).toHaveLength(1));
        expect(writes()[0]).toMatchObject({ method: 'PATCH', url: '/api/projects/sol1/stages/uat/parts/aut_1', body: { active: false } });
        await user.click(screen.getByTestId('part-switch-app_1'));
        expect((await screen.findByTestId('part-error-app_1')).textContent).toMatch(/has not been deployed/);
        expect(screen.getByTestId('part-drift-app_1')).toBeTruthy();
        expect(within(screen.getByTestId('part-tab_1')).getByText('No switch')).toBeTruthy();
    });

    it('pause and resume are stage-wide calls', async () => {
        wire({ handlers: { 'POST /pause': () => ok({ paused: true, changed: true, count: 1, failed: [] }) } });
        const user = userEvent.setup();
        renderTab();
        await user.click(await screen.findByTestId('stage-pause'));
        await waitFor(() => expect(writes().some(c => c.url.endsWith('/stages/uat/pause'))).toBe(true));
    });
});

describe('the Production gate', () => {
    it('exists on Production only', async () => {
        renderTab('uat');
        await screen.findByTestId('stage-settings');
        expect(screen.queryByTestId('block-gate')).toBeNull();
    });

    it('is locked without the approvals licence', async () => {
        (globalThis as unknown as { __lic: unknown }).__lic = { hasFeature: () => false, entDegraded: false, entError: null };
        renderTab('prd');
        expect(await screen.findByTestId('gate-unlicensed')).toBeTruthy();
        expect((screen.getByTestId('gate-toggle') as HTMLInputElement).disabled).toBe(true);
    });

    it('turning it on with only the owner in the chain is flagged before anything is sent', async () => {
        const user = userEvent.setup();
        renderTab('prd');
        await user.click(await screen.findByTestId('gate-toggle'));
        await user.selectOptions(screen.getByLabelText('Stage 1, approver 1'), 'u:u_owner');
        expect((await screen.findByTestId('gate-problems')).textContent).toMatch(/only has the Solution owner/);
        expect((screen.getByTestId('gate-save') as HTMLButtonElement).disabled).toBe(true);
        await user.selectOptions(screen.getByLabelText('Stage 1, approver 1'), 'u:u2');
        expect(screen.queryByTestId('gate-problems')).toBeNull();
        await user.click(screen.getByTestId('gate-save'));
        await waitFor(() => expect(writes()).toHaveLength(1));
        expect(writes()[0]).toMatchObject({ method: 'PATCH', url: '/api/projects/sol1/stages/prd', body: { settingsVersion: 3, requiresApproval: true, approvalPolicy: { stages: [{ key: 's1', approvers: [{ userId: 'u2' }], rule: 'all' }] } } });
        expect(screen.queryByTestId('gate-approval-requested')).toBeNull();     // a plain write, not a request
    });

    it('switching the gate off while it is on shows the approval-requested state', async () => {
        wire({
            settings: { requiresApproval: true, approvalPolicy: { stages: [{ key: 's1', approvers: [{ userId: 'u2' }] }] } },
            handlers: { 'PATCH /stages/prd': () => ok({ deployment: { id: 'd9', status: 'awaiting_approval', kind: 'settings' }, settings: SETTINGS({ stage: 'prd', requiresApproval: true }) }, 202) },
        });
        const user = userEvent.setup();
        renderTab('prd');
        await user.click(await screen.findByTestId('gate-toggle'));
        expect(screen.getByTestId('gate-asks-first')).toBeTruthy();
        await user.click(screen.getByTestId('gate-save'));
        expect(await screen.findByTestId('gate-approval-requested')).toBeTruthy();
        expect(writes()[0].body).toEqual({ settingsVersion: 3, requiresApproval: false });
        // Nothing changed yet: the toggle is back on what is stored.
        expect((screen.getByTestId('gate-toggle') as HTMLInputElement).checked).toBe(true);
    });
});

describe('danger zone', () => {
    it('needs the typed name, shows deleteData for removal, and a requested removal is not "removed"', async () => {
        wire({
            settings: { stage: 'prd', requiresApproval: true, approvalPolicy: { stages: [{ key: 's1', approvers: [{ userId: 'u2' }] }] } },
            handlers: { 'DELETE /stages/prd': () => ok({ deployment: { id: 'd1', status: 'awaiting_approval' } }, 202) },
        });
        const user = userEvent.setup();
        renderTab('prd');
        await user.click(await screen.findByTestId('danger-mode-delete'));
        await user.click(screen.getByTestId('danger-delete-data'));
        expect(screen.getByTestId('danger-data-warning')).toBeTruthy();
        expect(screen.getByTestId('danger-needs-approval')).toBeTruthy();
        const go = screen.getByTestId('danger-submit') as HTMLButtonElement;
        expect(go.disabled).toBe(true);
        await user.type(screen.getByTestId('danger-confirm'), 'Onboard');
        expect(go.disabled).toBe(true);
        await user.type(screen.getByTestId('danger-confirm'), 'ing');
        expect(go.disabled).toBe(false);
        await user.click(go);
        expect((await screen.findByTestId('danger-result')).getAttribute('data-result')).toBe('removal_requested');
        expect(writes()[0]).toMatchObject({ method: 'DELETE', url: '/api/projects/sol1/stages/prd', body: { confirm: 'Onboarding', mode: 'delete', deleteData: true } });
    });

    it('detach sends mode detach and offers the way back', async () => {
        wire({ handlers: { 'DELETE /stages/uat': () => ok({ detached: true }) } });
        const user = userEvent.setup();
        const { onChanged } = renderTab('uat');
        await user.type(await screen.findByTestId('danger-confirm'), 'Onboarding');
        await user.click(screen.getByTestId('danger-submit'));
        expect((await screen.findByTestId('danger-result')).getAttribute('data-result')).toBe('detached');
        expect(writes()[0].body).toEqual({ confirm: 'Onboarding', mode: 'detach' });
        await user.click(screen.getByTestId('danger-done'));
        expect(onChanged).toHaveBeenCalled();
    });

    it('a stage editor is told it is not theirs to remove', async () => {
        wire({ settings: { role: 'editor' } });
        renderTab('uat', { stageRow: row('uat', { role: 'editor' }) });
        expect(await screen.findByTestId('danger-no-access')).toBeTruthy();
    });
});

describe('Dev variable declarations', () => {
    const wireDecls = (extra: Record<string, Handler> = {}) => {
        calls = [];
        (globalThis as unknown as { __authFetch: unknown }).__authFetch = vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
            const call: Call = { url, method: init?.method || 'GET', body: init?.body ? JSON.parse(init.body) : null };
            calls.push(call);
            for (const [needle, handler] of Object.entries(extra)) if (`${call.method} ${url}`.includes(needle)) return handler(call);
            return ok({ variables: [{ name: 'tax_rate', type: 'number', choices: null, description: '', required: true, steering: false }] });
        });
    };

    it('refuses a secret-like name inline, before anything is sent', async () => {
        wireDecls();
        const user = userEvent.setup();
        render(<VariablesDeclarations solutionId="sol1" canEdit />);
        await screen.findByTestId('variable-declarations');
        await user.click(screen.getByText('Add a variable'));
        const rows = screen.getAllByTestId('decl-row');
        await user.type(within(rows[1]).getByLabelText('Variable name'), 'api_key');
        expect(within(rows[1]).getByTestId('decl-problem').textContent).toMatch(/Store secrets in a connection/);
        expect((screen.getByTestId('decls-save') as HTMLButtonElement).disabled).toBe(true);
        expect(calls.filter(c => c.method !== 'GET')).toHaveLength(0);
    });

    it('saves valid declarations; url and email always steer', async () => {
        wireDecls();
        const user = userEvent.setup();
        render(<VariablesDeclarations solutionId="sol1" canEdit />);
        await screen.findByTestId('variable-declarations');
        await user.click(screen.getByText('Add a variable'));
        const added = screen.getAllByTestId('decl-row')[1];
        await user.type(within(added).getByLabelText('Variable name'), 'report_to');
        await user.selectOptions(within(added).getByLabelText('Type'), 'email');
        await user.click(screen.getByTestId('decls-save'));
        await waitFor(() => expect(calls.some(c => c.method === 'PUT')).toBe(true));
        const body = calls.find(c => c.method === 'PUT')?.body as { variables: Array<{ name: string; steering: boolean }> };
        expect(body.variables.map(v => [v.name, v.steering])).toEqual([['tax_rate', false], ['report_to', true]]);
    });

    it('a server refusal of the name is shown, and an unreadable list is not "no variables"', async () => {
        wireDecls({ 'PUT': () => bad(400, { error: 'x', code: 'variable_secret_name', details: { name: 'x' } }) });
        const user = userEvent.setup();
        render(<VariablesDeclarations solutionId="sol1" canEdit />);
        await screen.findByTestId('variable-declarations');
        await user.type(screen.getByLabelText('Description'), 'hi');
        await user.click(screen.getByTestId('decls-save'));
        expect((await screen.findByTestId('decl-refused')).textContent).toMatch(/looks like a secret/);
    });

    it('says when the declarations could not be read', async () => {
        wireDecls({ 'GET': () => bad(500, { error: 'boom' }) });
        render(<VariablesDeclarations solutionId="sol1" canEdit />);
        expect(await screen.findByTestId('decls-unreadable')).toBeTruthy();
    });
});
