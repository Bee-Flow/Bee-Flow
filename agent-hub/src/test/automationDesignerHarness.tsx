import { render } from '@testing-library/react';
import type { Mock } from 'vitest';
import { vi } from 'vitest';
import type { Row } from './automationDesignerStubs';
import { withQueryClient } from './render';
import AITasksDesigner from '../components/automation/index';
import EntitlementsContext from '../components/licensing/EntitlementsContext';
import type { EntitlementsValue } from '../components/licensing/EntitlementsContext';

/**
 * Shared harness of the AITasksDesigner characterisation tests: an `authFetch`
 * router for the reads the designer makes, stand-ins for the two heavy panes
 * (builder, launcher) that expose the props they were given, and `mountDesigner`.
 */

export interface FakeResponse { ok: boolean; status: number; json: () => Promise<unknown>; text: () => Promise<string> }
export type AuthFetchMock = Mock<(url: string, init?: RequestInit) => Promise<FakeResponse>>;
export const res = (status: number, body: unknown = {}): FakeResponse => ({ ok: status < 400, status, json: async () => body, text: async () => '' });
export const INVOICES: Row = { id: 'a1', title: 'Invoice sync', isActive: true, triggerType: 'manual', folderId: null };
export const REPORT: Row = { id: 'a2', title: 'Weekly report', isActive: false, triggerType: 'manual', folderId: null };
export const BLOCK = { id: 'st1', title: 'Send to Slack', isPublished: false };

/** What the list and the building-blocks reads answer; a test replaces one. */
export const scenario: { list: () => FakeResponse; steps: () => FakeResponse } = {
    list: () => res(200, { automations: [INVOICES, REPORT] }),
    steps: () => res(200, { steps: [BLOCK] }),
};

type RouteRow = [method: string, matches: (url: string) => boolean, answer: () => FakeResponse];
const exactly = (path: string) => (url: string) => url === path;

export function installRouter(authFetch: AuthFetchMock) {
    scenario.list = () => res(200, { automations: [INVOICES, REPORT] });
    scenario.steps = () => res(200, { steps: [BLOCK] });
    const routes: RouteRow[] = [
        ['GET', (u) => /^\/api\/automation\/?$/.test(u), () => scenario.list()],
        ['GET', exactly('/api/automation/folders'), () => res(200, { folders: [] })],
        ['GET', (u) => /^\/api\/step\/?$/.test(u), () => scenario.steps()],
        ['GET', exactly('/api/automation/_runs/active'), () => res(200, { active: [{ automationId: 'a2' }] })],
        ['GET', exactly('/api/automation/templates/t1'), () => res(200, { template: { id: 't1', title: 'Tmpl', definition: {} } })],
        ['POST', exactly('/api/automation/'), () => res(200, { automation: { id: 'from-tmpl' } })],
        ['POST', exactly('/api/automation/a1/duplicate'), () => res(200, { automation: { id: 'copy-1' } })],
        ['POST', exactly('/api/automation/import'), () => res(200, { automation: { id: 'imp-1' }, warnings: [] })],
    ];
    authFetch.mockReset();
    authFetch.mockImplementation(async (url, init) => {
        const method = init?.method || 'GET';
        const hit = routes.find(([m, matches]) => m === method && matches(url));
        return hit ? hit[2]() : res(200, {});
    });
}

export const sent = (authFetch: AuthFetchMock, method: string, url: string) =>
    authFetch.mock.calls.filter(([u, i]) => u === url && (i?.method || 'GET') === method);

export function entitlements(allowed: boolean, loading = false): EntitlementsValue {
    const none = { core: [], beta: [], integration: [] };
    return {
        loading, degraded: false, tier: 'full', mode: 'cloud', effective: none, ceiling: none, can: () => allowed,
        inCeiling: () => true, lockReason: () => null, hasTier: () => true, reload: () => {},
    };
}

export interface DesignerOptions {
    initialTaskId?: string; initialStepId?: string; initialFlowletKey?: string; initialBuilderView?: string; embedded?: boolean;
}

export function mountDesigner(options: DesignerOptions = {}, ent = entitlements(true)) {
    const onNavigate = vi.fn();
    const onEditingChange = vi.fn();
    // index.jsx infers these props as `null` from its `= null` defaults; their contract is a string.
    const widened: Record<string, unknown> = {
        initialTaskId: options.initialTaskId ?? null, initialStepId: options.initialStepId ?? null,
        initialFlowletKey: options.initialFlowletKey ?? null, initialBuilderView: options.initialBuilderView ?? null,
    };
    render(withQueryClient(
        <EntitlementsContext.Provider value={ent}>
            <AITasksDesigner initialRunId={null} initialRunStepId={null} initialFrom={null} onNavigate={onNavigate}
                embedded={options.embedded ?? true} user={null} onEditingChange={onEditingChange} {...widened} />
        </EntitlementsContext.Provider>,
    ));
    return { onNavigate, onEditingChange };
}
