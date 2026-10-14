import { render as rtlRender, act, waitFor, cleanup } from '@testing-library/react';
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * Characterisation of the shell's lifecycle wiring: Activate / Pause, the AI
 * Act gate in front of going live (dialog, then one retry of the same call),
 * the trigger health check, and Step mode (org groups for the sharing menu,
 * Publish). Pinned before BuilderShell was split into hooks, so the split had
 * to keep every call, URL and order below.
 *
 * Same harness as BuilderShell.triggerPayload.test.jsx: stubbed children hand
 * back what the shell gave them, `authFetch` stands in for the server.
 */

vi.mock('../../../utils/helpers', () => ({ API_BASE: '', authFetch: vi.fn() }));
vi.mock('../../shared/Toast', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock('./DiagramPane', () => ({ default: () => null, applyAddNode: (d: unknown) => d }));
vi.mock('../../chat/InputArea', () => ({ default: () => null }));
vi.mock('../../admin/Studio/Executions/ExecutionsPanel', () => ({ default: () => null }));
vi.mock('./versions/VersionsTab', () => ({ default: () => null }));
vi.mock('../../shared/useConfirm', () => ({
    default: () => ({ confirm: () => Promise.resolve(true), confirmDialog: null }),
}));

let header: any = null;
let diagnose: any = null;
let aiAct: any = null;
vi.mock('./BuilderHeader', () => ({ default: (p: any) => { header = p; return null; } }));
vi.mock('./BuildTab', () => ({ default: (p: any) => { header = p.headerProps; return null; } }));
vi.mock('./SettingsTab', () => ({ default: () => null }));
vi.mock('./TriggerDiagnosePanel', () => ({ default: (p: any) => { diagnose = p; return null; } }));
vi.mock('./settings/AiActQuestionsDialog', () => ({ default: (p: any) => { aiAct = p; return null; } }));

import BuilderShellJsx from './BuilderShell.jsx';
import { queryWrapper } from '../../../test/queryWrapper';
import { authFetch } from '../../../utils/helpers';

const BuilderShell = BuilderShellJsx as unknown as React.ComponentType<Record<string, unknown>>;
const render = (ui: React.ReactElement) => rtlRender(ui, { wrapper: queryWrapper() });
const fetchMock = vi.mocked(authFetch);

const DEF = {
    schemaVersion: 2,
    trigger: { id: 'trg', type: 'trigger', kind: 'app_event', label: 'App event' },
    steps: [{ id: 's1', type: 'ai_step', label: 'Draft it', prompt: 'hi', position: { x: 0, y: 0 } }],
    edges: [{ from: 'trg', to: 's1' }],
};

let row: Record<string, any>;
let calls: Array<{ method: string; url: string }>;
let activateAnswers: Array<{ status: number; body: unknown }>;
const json = (body: unknown, { ok = true, status = 200 } = {}) => ({
    ok, status, json: () => Promise.resolve(body), text: () => Promise.resolve(JSON.stringify(body)),
});

function server(url: string, opts: RequestInit = {}) {
    const method = opts.method || 'GET';
    calls.push({ method, url });
    if (url === '/api/automation/a1' && method === 'GET') return Promise.resolve(json({ automation: { ...row } }));
    if (url === '/api/automation/a1/activate') {
        const next = activateAnswers.shift() || { status: 200, body: null };
        if (next.status !== 200) return Promise.resolve(json(next.body, { ok: false, status: next.status }));
        row = { ...row, isActive: true, isDraft: false };
        return Promise.resolve(json({ automation: { ...row } }));
    }
    if (url === '/api/automation/a1/deactivate') {
        row = { ...row, isActive: false };
        return Promise.resolve(json({ automation: { ...row } }));
    }
    if (url === '/api/automation/a1/diagnose-trigger') return Promise.resolve(json({ ok: true, checks: ['subscribed'] }));
    if (url === '/api/step/st1' && method === 'GET') return Promise.resolve(json({ step: { ...row } }));
    if (url === '/api/step/st1/publish') return Promise.resolve(json({ step: { ...row, publishedVersion: 1 } }));
    if (url === '/auth/groups') return Promise.resolve(json([{ id: 'g1', name: 'Sales' }]));
    if (url === '/api/automation/_runs/active') return Promise.resolve(json({ active: [] }));
    if (url.startsWith('/api/automation/builder/session/')) return Promise.resolve(json({}, { ok: false, status: 404 }));
    if (url.startsWith('/ai/config/tiers-for-user')) return Promise.resolve(json({ auto: { label: 'Auto' } }));
    return Promise.resolve(json({}));
}

const posts = () => calls.filter(c => c.method === 'POST').map(c => c.url);

beforeEach(() => {
    header = null; diagnose = null; aiAct = null;
    calls = [];
    activateAnswers = [];
    row = { id: 'a1', title: 'Intake', definition: DEF, isActive: false, isDraft: false };
    fetchMock.mockReset();
    fetchMock.mockImplementation(server as any);
});
afterEach(() => { cleanup(); });

async function mountAutomation() {
    render(<BuilderShell automationId="a1" onBack={() => {}} user={{ id: 'u1' }} />);
    await waitFor(() => expect(header?.automation?.id).toBe('a1'));
}

describe('BuilderShell lifecycle (characterisation)', () => {
    it('Activate posts /activate and the header follows the answer; Pause posts /deactivate', async () => {
        await mountAutomation();
        expect(header.isActive).toBe(false);
        expect(header.statusLabel).toBe('Paused');
        expect(header.canActivate).toBe(true);
        expect(header.canDiagnose).toBe(true);

        await act(async () => { await header.onActivate(); });
        await waitFor(() => expect(header.isActive).toBe(true));
        expect(header.statusLabel).toBe('Live');
        expect(header.busy).toBe(false);
        expect(posts()).toContain('/api/automation/a1/activate');

        await act(async () => { await header.onDeactivate(); });
        await waitFor(() => expect(header.isActive).toBe(false));
        expect(posts().filter(u => u.endsWith('/activate') || u.endsWith('/deactivate')))
            .toEqual(['/api/automation/a1/activate', '/api/automation/a1/deactivate']);
    });

    it('an AI Act refusal opens the questions dialog, and answering retries Activate once', async () => {
        activateAnswers = [{ status: 409, body: { error: 'Answer the AI Act questions first.', code: 'ai_act_check_required' } }];
        await mountAutomation();

        await act(async () => { await header.onActivate(); });
        await waitFor(() => expect(aiAct).not.toBeNull());
        expect(aiAct.automationId).toBe('a1');
        expect(aiAct.action).toBe('activate');
        expect(header.isActive).toBe(false);

        await act(async () => { aiAct.onAnswered(); });
        await waitFor(() => expect(header.isActive).toBe(true));
        expect(posts().filter(u => u.endsWith('/activate'))).toEqual(['/api/automation/a1/activate', '/api/automation/a1/activate']);
    });

    it('Diagnose posts /diagnose-trigger and hands the answer to the panel', async () => {
        await mountAutomation();
        expect(diagnose).toBeNull();

        await act(async () => { await header.onDiagnose(); });
        await waitFor(() => expect(diagnose?.loading).toBe(false));
        expect(diagnose.result).toEqual({ ok: true, checks: ['subscribed'] });
        expect(diagnose.error).toBeNull();
        expect(diagnose.anchorRef).toBe(header.diagnoseAnchorRef);
        expect(posts()).toContain('/api/automation/a1/diagnose-trigger');
    });

    it('Step mode reads the org groups for the sharing menu and Publish posts to the Step router', async () => {
        row = { id: 'st1', title: 'Lookup', definition: { schemaVersion: 2, trigger: { id: 'trg', type: 'trigger', kind: 'layer_input', params: [] }, steps: [{ id: 'out', type: 'layer_output', fields: {} }], edges: [] } };
        const onPublished = vi.fn();
        render(<BuilderShell automationId="st1" mode="step" onBack={() => {}} user={{ id: 'u1' }} onPublished={onPublished} />);
        await waitFor(() => expect(header?.step?.id).toBe('st1'));
        await waitFor(() => expect(header.orgGroups).toEqual([{ id: 'g1', name: 'Sales' }]));
        expect(header.automation).toBeNull();
        expect(header.canActivate).toBe(false);
        expect(header.onAssistant).toBeNull();
        expect(header.onExportJson).toBeNull();

        await act(async () => { await header.onPublishStep(); });
        expect(posts()).toContain('/api/step/st1/publish');
        expect(onPublished).toHaveBeenCalledWith('st1');
        expect(header.busy).toBe(false);
    });

    it('an automation never reads the org groups', async () => {
        await mountAutomation();
        expect(header.orgGroups).toEqual([]);
        expect(calls.some(c => c.url === '/auth/groups')).toBe(false);
    });
});
