// The world the tests of an opened task share (./CoworkTaskView.test.tsx, ./CoworkTaskSettings.test.tsx): one task,
// "Weekly digest" with approved fixed steps, served over a recording fetch (no module is mocked), and the page opened
// on it. A test replaces only the part of the world it is about.
import type { ReactNode } from 'react';
import { vi } from 'vitest';
import userEvent from '@testing-library/user-event';
import { renderWithClient } from '@/test/render';
import { jsonResponse, stubRecordingFetch, type RecordedCall } from '@/test/recordingFetch';
import CoworkTaskView from './CoworkTaskView';
import EntitlementsContext, { useEntitlements } from '../../licensing/EntitlementsContext';
import type { CoworkSheetPanel, CoworkSheetPanelProps } from '../coworkSheetPanels';

export const ITEM = {
    id: 'w1', title: 'Weekly digest', prompt: 'Sum up the week.', isActive: true, repeatInterval: 'weekly', daysOfWeek: ['mon'], timeOfDay: '09:00',
    nextRunAt: '2099-11-30T08:00:00.000Z', lastRunAt: '2026-11-23T08:00:00.000Z', lastStatus: 'success', runCount: 3, agentId: null, enabledApps: ['outlook'],
};

const step = (id: string, title: string, over: Record<string, unknown> = {}) => ({ id, type: 'integration_action', kind: 'fixed', title, effect: 'reads', app: 'outlook', tool: 'x', readsOutsideText: false, depth: 0, ...over });
const FINGERPRINT = 'f'.repeat(64);
const PERMISSIONS = { v: 1, grants: [{ app: 'outlook', effect: 'reads', tools: ['x'] }], sends: 'owner', ai: true, outsideText: false };

/** Approved fixed steps: read the mail, keep this week (in between), write the digest, tell the owner. */
const PLAN = {
    automationId: 'a1',
    draft: {
        view: {
            trigger: 'schedule', makeUp: { fixed: 2, ai: 1, ask: 0, deliver: 1 },
            steps: [step('sum', 'Write the digest', { kind: 'ai', app: null }), step('read', 'Read the mail'), step('trim', 'Keep this week', { type: 'filter', helper: true, app: null }), step('tell', 'Tell me', { kind: 'deliver', effect: 'sends', app: null })],
            runOrder: ['read', 'trim', 'sum', 'tell'],
        },
        permissions: PERMISSIONS, findings: [], fingerprint: FINGERPRINT, recipients: { tell: 'owner' },
    },
    approved: { version: 2, fingerprint: FINGERPRINT, approvedAt: null, permissions: PERMISSIONS },
    widens: [], upToDate: true,
};

/** The same steps before their first approval, tested, with what the test produced. */
export const PLAN_WAITING = {
    ...PLAN, approved: null, upToDate: false,
    tried: { status: 'passed', current: true, required: true, blocksApproval: false, summary: null, problems: [], rounds: 1 },
    triedResult: { stepId: 'tell', title: 'Weekly digest', text: 'Three invoices are overdue.\nTwo meetings moved.' },
};

/** The task as the AI does it each time: no steps of its own. */
export const NO_PLAN = { automationId: null, draft: null, approved: null, widens: [], upToDate: false };

export const RUN = { id: 'r1', status: 'success', startedAt: '2026-11-23T08:00:00.000Z', result: '3 invoices are overdue.', producedOutput: true };

/** "Check the steps" waits for the owner. */
export const NEEDS_APPROVAL = { kind: 'plan', itemId: 'w1', title: 'Weekly digest', runId: null, since: null, reason: null, plan: 'first', tried: 'passed' };

const LEVEL = (level: string, open = true) => ({ level, open, asksBefore: [] });
export const INDEPENDENCE = {
    chosen: null, level: 'asks_before_sending', asksAvailable: true, ceiling: 'on_its_own', letThrough: 12, needed: 10,
    options: [LEVEL('asks_everything'), LEVEL('asks_before_sending'), LEVEL('on_its_own')],
};

export interface World {
    item?: unknown;
    plan?: unknown;
    runs?: unknown[];
    needs?: unknown[];
    testProgress?: () => unknown;
    proposals?: unknown[];
    shared?: unknown;
    independence?: unknown;
    audit?: unknown[];
    colleagues?: unknown[];
    /** The organisation has automations (fixed steps can be chosen). */
    automations?: boolean;
}

/** What the world answers to a read of one task's own data, by the path after its id. */
function taskRead(world: World): Record<string, unknown> {
    return {
        '': world.item ?? ITEM,
        '/plan': world.plan ?? PLAN,
        '/runs': { runs: world.runs ?? [RUN], total: (world.runs ?? [RUN]).length },
        '/proposals': { proposals: world.proposals ?? [] },
        '/start': { kind: 'schedule', after: null, datatableId: null, inFolder: null, hasAddress: false },
        '/goal': { goal: null },
        '/plan/independence': world.independence ?? INDEPENDENCE,
        '/plan/trust': { entries: [], needed: 5, ceilingAllows: true },
        '/audit': { entries: world.audit ?? [] },
        '/hand-over/colleagues': { colleagues: world.colleagues ?? [] },
        '/shares': { shares: [] },
        '/receipts': { verdict: { ok: true, count: 0, problem: null, unsigned: 0 }, missingRuns: 0, keyId: null, receipts: [] },
    };
}

const TASK = '/api/cowork/w1';
const pathOf = (url: string): string => new URL(url, 'http://x').pathname;

/** What the world answers to a read beside the task itself. */
function otherRead(world: World): Record<string, unknown> {
    return {
        '/api/cowork/needs-you': { needs: world.needs ?? [] },
        '/api/cowork/desks': { desks: [] },
        '/api/cowork/shared/w1': world.shared ?? {},
        '/api/cowork/shared': { items: [{ id: 'w1', ownerName: 'Sam Peters', title: 'Stock check', role: 'viewer' }] },
    };
}

function testResponse(progress: World['testProgress'], path: string, method: string) {
    if (progress && path === TASK + '/plan/try' && method === 'POST') return jsonResponse({ tryId: 'try-1', fingerprint: FINGERPRINT });
    if (progress && path === TASK + '/plan/try/try-1') return jsonResponse(progress());
    return null;
}

/** Serve the world; answers with the calls made so far and a way to find one. */
function serveTask(world: World = {}) {
    const reads = taskRead(world);
    const others = otherRead(world);
    const calls = stubRecordingFetch(({ url, method, body }) => {
        const path = pathOf(url);
        const testReply = testResponse(world.testProgress, path, method);
        if (testReply) return testReply;
        if (method === 'PUT' && path === `${TASK}/plan/independence`) return jsonResponse({ ...INDEPENDENCE, chosen: (body as { level?: string }).level });
        if (method !== 'GET') return jsonResponse(method === 'DELETE' ? { success: true } : {});
        if (path === TASK && world.item === null) return jsonResponse({ error: 'Forbidden' }, 403);
        if (path.startsWith(TASK) && path.slice(TASK.length) in reads) return jsonResponse(reads[path.slice(TASK.length)]);
        // The owner has Microsoft 365 connected: Outlook, OneDrive and the like are theirs to switch on.
        if (path.includes('/ai/config/tiers-for-user')) return jsonResponse({ auto: {}, fast: { label: 'Fast', modelId: 'mail-model' } });
        if (path.endsWith('/ai/user-settings')) return jsonResponse({ isMicrosoftUser: true });
        return jsonResponse(others[path] ?? {});
    });
    const sent = (method: string, path: string): RecordedCall | undefined => calls.find((c) => c.method === method && pathOf(c.url) === path);
    const all = (method: string, path: string): RecordedCall[] => calls.filter((c) => c.method === method && pathOf(c.url) === path);
    return { calls, sent, all };
}

/** An organisation with automations: a task may get fixed steps. */
function WithAutomations({ children }: { children: ReactNode }) {
    const entitlements = useEntitlements();
    return <EntitlementsContext.Provider value={{ ...entitlements, loading: false, can: (id) => id === 'automations' }}>{children}</EntitlementsContext.Provider>;
}

/** Open the task's page on the world. */
export function openTask(world: World = {}, panel: CoworkSheetPanel = { kind: 'task', id: 'w1' }) {
    const served = serveTask(world);
    const close = vi.fn();
    const open = vi.fn();
    const props: CoworkSheetPanelProps = { panel, user: null, close, open, fillComposer: vi.fn() };
    const page = <CoworkTaskView {...props} />;
    renderWithClient(world.automations ? <WithAutomations>{page}</WithAutomations> : page);
    return { ...served, close, open, user: userEvent.setup() };
}
