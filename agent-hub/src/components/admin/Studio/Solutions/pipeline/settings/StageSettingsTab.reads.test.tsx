import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../../../../utils/helpers', () => ({
    API_BASE: '',
    authFetch: (...args: unknown[]) => (globalThis as unknown as { __authFetch: (...a: unknown[]) => unknown }).__authFetch(...args),
}));
vi.mock('../../../../../licensing/LicenseContext', () => ({
    useLicenseContext: () => ({ hasFeature: () => true, entDegraded: false, entError: null }),
}));
vi.mock('../../SolutionAccessDialog', () => ({ default: () => null }));

import type { StageKey } from '../stagesApi';
import StageSettingsTab from './StageSettingsTab';

type Call = { url: string; method: string; body: Record<string, unknown> | null };
let calls: Call[] = [];
const ok = (body: unknown, status = 200) => ({ ok: true, status, json: async () => body });
const bad = (status: number, body: unknown) => ({ ok: false, status, json: async () => body });

const settings = (stage: string, over: Record<string, unknown> = {}) => ({
    stage, projectId: `p_${stage}`, solutionId: 'sol1', settingsVersion: 3, enabled: true, paused: false, newPartsActive: true,
    runAs: { userId: 'u_owner', name: 'Olga' }, requiresApproval: false, approvalPolicy: null, rollbackNeedsApproval: false,
    bindingsPending: false, currentRelease: { id: 'rel_7', seq: 7 }, role: 'owner',
    parts: [{ ref: 'app_1', kind: 'app', name: 'Desk', entityId: 'e2', active: true, retired: false, drift: false }],
    inbound: [], ...over,
});
const REQS = {
    release: { id: 'rel_7', seq: 7 },
    requirements: [
        { slot: 'connection:cn_1', kind: 'connection', label: 'API', neededBy: ['app_1'], bound: true, suggested: null, binding: { connectionId: 'c_gone', allowedHosts: [] } },
        { slot: 'seats:app_1:s1', kind: 'approver_seats', label: 'Who approves', neededBy: ['app_1'], bound: false, suggested: { stages: [] }, binding: null },
        { slot: 'table:orders', kind: 'table', label: 'Orders', neededBy: [], bound: false, suggested: null, binding: null },
    ],
};

function wire(handlers: Record<string, (c: Call) => unknown> = {}, over: Record<string, unknown> = {}) {
    calls = [];
    (globalThis as unknown as { __authFetch: unknown }).__authFetch = vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
        const call: Call = { url, method: init?.method || 'GET', body: init?.body ? JSON.parse(init.body) : null };
        calls.push(call);
        for (const [needle, handler] of Object.entries(handlers)) {
            const [method, part] = needle.split(' ');
            if (call.method === method && url.includes(part)) return handler(call);
        }
        const stage = url.includes('/stages/prd') ? 'prd' : 'uat';
        if (call.method === 'GET' && /\/stages\/(uat|prd)$/.test(url)) return ok(settings(stage, over));
        if (call.method === 'GET' && url.split('?')[0].endsWith('/requirements')) return ok(REQS);
        if (call.method === 'GET' && url.endsWith('/variables')) return ok({ stage, variables: [], values: [] });
        if (url.includes('/approvals/directory')) return ok({ members: [{ id: 'u2', name: 'Pim' }], groups: [] });
        if (url.includes('/integrations/connections')) return ok({ connections: [{ id: 'c_prd', label: 'Prod API' }] });
        return ok({});
    });
}
const renderTab = (stage: StageKey = 'uat', role: string | undefined = 'owner') =>
    render(<StageSettingsTab solutionId="sol1" solutionName="Onboarding" stage={stage} stageRow={{ stage, projectId: `p_${stage}`, currentRelease: null, lastDeployment: null, pending: null, bindingsPending: false, enabled: true, role } as never} onChanged={vi.fn()} />);

beforeEach(() => wire());

describe('what the settings page reads', () => {
    it('asks for the requirements of the release the stage runs', async () => {
        renderTab();
        await screen.findByTestId('binding-table:orders');
        expect(calls.some(c => c.url === '/api/projects/sol1/stages/uat/requirements?releaseId=rel_7')).toBe(true);
    });

    it('a people read that failed is said, not shown as an empty picker', async () => {
        wire({ 'GET /approvals/directory': () => bad(500, { error: 'boom' }) });
        renderTab();
        const card = await screen.findByTestId('binding-seats:app_1:s1');
        expect(await within(card).findByTestId('directory-unreadable')).toBeTruthy();
        expect(within(card).queryByRole('combobox')).toBeNull();
    });

    it('a connections read that failed is said, and a bound connection outside the list stays visible', async () => {
        wire({ 'GET /integrations/connections': () => bad(500, { error: 'boom' }) });
        renderTab();
        const card = await screen.findByTestId('binding-connection:cn_1');
        expect(await within(card).findByTestId('connections-unreadable')).toBeTruthy();
        expect((within(card).getByLabelText('Connection id') as HTMLInputElement).value).toBe('c_gone');
    });

    it('a bound connection that is not in the list is still shown', async () => {
        renderTab();
        const card = await screen.findByTestId('binding-connection:cn_1');
        await waitFor(() => expect((within(card).getByLabelText('Connection') as HTMLSelectElement).value).toBe('c_gone'));
    });
});

describe('seat shape follows the part that needs the slot', () => {
    it('an app approval slot is written with flat ids even when Dev suggests a chain', async () => {
        const user = userEvent.setup();
        renderTab();
        const card = await screen.findByTestId('binding-seats:app_1:s1');
        await user.selectOptions(await within(card).findByLabelText('Who decides'), 'u:u2');
        await user.click(screen.getByTestId('bindings-save'));
        await waitFor(() => expect(calls.some(c => c.method === 'PUT' && c.url.endsWith('/bindings'))).toBe(true));
        const put = calls.find(c => c.method === 'PUT' && c.url.endsWith('/bindings'));
        expect(put?.body).toMatchObject({ bindings: [{ slot: 'seats:app_1:s1', value: { assigneeUserId: 'u2' } }] });
    });
});

describe('an unsaved gate edit', () => {
    it('survives a stale reload', async () => {
        wire({ 'PUT /bindings': () => bad(409, { error: 'changed', code: 'settings_stale' }) });
        const user = userEvent.setup();
        renderTab('prd');
        await user.click(await screen.findByTestId('gate-toggle'));
        await user.type(within(await screen.findByTestId('binding-table:orders')).getByRole('textbox'), 'dt_1');
        await user.click(screen.getByTestId('bindings-save'));
        expect(await screen.findByTestId('settings-stale')).toBeTruthy();
        await waitFor(() => expect(calls.filter(c => c.url === '/api/projects/sol1/stages/prd').length).toBeGreaterThan(1));
        expect((screen.getByTestId('gate-toggle') as HTMLInputElement).checked).toBe(true);
    });
});

describe('an organisation admin without a stage role', () => {
    it('can pause and detach when the read answers role org_admin', async () => {
        wire({}, { role: 'org_admin' });
        renderTab('uat', undefined);
        await screen.findByTestId('stage-settings');
        expect(screen.queryByTestId('danger-no-access')).toBeNull();
        expect(screen.getByTestId('block-danger').textContent).not.toMatch(/not yours/i);
    });
});
