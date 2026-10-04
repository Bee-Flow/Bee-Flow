import { render as rtlRender, screen, waitFor, cleanup, act } from '@testing-library/react';
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * An automation managed by a Solution stage is read-only for real (design 9):
 *   - the canvas (BuildTab, which owns DiagramPane) gets `readOnly`;
 *   - the banner is mounted through the header's breadcrumb strip;
 *   - the AI builder has no way in (header entry, panel, send);
 *   - nothing is saved, whoever asks (a stale edit, undo, the inspector);
 *   - the live state loses Make-live while On/Off stay;
 *   - a 409 managed_part on a save turns an unmanaged-looking tab read-only.
 *
 * Same seams as BuilderShell.breadcrumbSlot.test.jsx: the shell is measured
 * through what it hands BuildTab and BuilderHeader, which are stubbed.
 */

vi.mock('../../../utils/helpers', () => ({ API_BASE: '', authFetch: vi.fn() }));
vi.mock('../../shared/Toast', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock('./DiagramPane', () => ({ default: () => null, applyAddNode: (d: unknown) => d }));
vi.mock('../../chat/InputArea', () => ({ default: () => null }));
vi.mock('../../admin/Studio/Executions/ExecutionsPanel', () => ({ default: () => null }));
vi.mock('./versions/VersionsTab', () => ({ default: () => null }));
vi.mock('./TriggerDiagnosePanel', () => ({ default: () => null }));
vi.mock('../../shared/useConfirm', () => ({
    default: () => ({ confirm: () => Promise.resolve(true), confirmDialog: null }),
}));

// What the stubbed BuildTab was last given: the seam this suite measures the shell through.
let tab: any = null;
vi.mock('./BuilderHeader', () => ({ default: () => null }));
vi.mock('./BuildTab', () => ({ default: (p: unknown) => { tab = p; return null; } }));
vi.mock('./SettingsTab', () => ({ default: () => null }));
vi.mock('./AppRefBreadcrumb', () => ({ default: () => null }));
vi.mock('./UsedByButtonsCapsule', () => ({ default: () => <div data-testid="capsule" /> }));

import BuilderShellJsx from './BuilderShell.jsx';
import { liveStateOf } from './header/liveState';
import { queryWrapper } from '../../../test/queryWrapper';
import { authFetch } from '../../../utils/helpers';

// The shell is a .jsx component whose props are inferred from defaults; the suite passes the few it needs.
const BuilderShell = BuilderShellJsx as unknown as React.ComponentType<Record<string, unknown>>;

const render = (ui: React.ReactElement) => rtlRender(ui, { wrapper: queryWrapper() });

const DEF = {
    schemaVersion: 2,
    trigger: { id: 'trg', type: 'trigger', kind: 'manual', label: 'Manual' },
    steps: [{ id: 's1', type: 'ai_step', label: 'Draft it', prompt: 'hi', position: { x: 0, y: 0 } }],
    edges: [{ from: 'trg', to: 's1' }],
};
const MANAGED = { solutionId: 's1', solutionName: 'Intake', stage: 'prd', releaseSeq: 7, devRef: { kind: 'automation', id: 'dev-a1' } };

let row: Record<string, any>;
let managed: unknown;
let putStatus: number;
const json = (body: unknown, { ok = true, status = 200 } = {}) => ({ ok, status, json: () => Promise.resolve(body) });
const fetchMock = vi.mocked(authFetch);
const puts = () => fetchMock.mock.calls.filter(([url, o]) => url === '/api/automation/a1' && (o as RequestInit | undefined)?.method === 'PUT');

async function mount(props: Record<string, unknown> = {}) {
    render(<BuilderShell automationId="a1" onBack={() => {}} user={{ id: 'u1' }} {...props} />);
    await waitFor(() => expect(tab?.automation?.id).toBe('a1'));
}

beforeEach(() => {
    tab = null;
    managed = MANAGED;
    putStatus = 200;
    row = { id: 'a1', title: 'Intake', definition: DEF, isActive: true, isDraft: false, version: 5, liveVersion: 3, neverLive: false, pendingChanges: 2 };
    fetchMock.mockReset();
    fetchMock.mockImplementation(((url: string, opts: RequestInit = {}) => {
        const method = opts.method || 'GET';
        if (url === '/api/automation/a1' && method === 'GET') return Promise.resolve(json({ automation: { ...row }, summary: null, managed }));
        if (url === '/api/automation/a1' && method === 'PUT') {
            if (putStatus === 409) {
                return Promise.resolve(json({
                    error: 'This part is managed by a Solution stage. Change it in Dev and deploy.',
                    code: 'managed_part', details: { solutionId: 's2', stage: 'uat' },
                }, { ok: false, status: 409 }));
            }
            row = { ...row, ...JSON.parse(String(opts.body)) };
            return Promise.resolve(json({ automation: { ...row } }));
        }
        if (url === '/api/automation/_runs/active') return Promise.resolve(json({ active: [] }));
        if (url.startsWith('/api/automation/builder/session/')) return Promise.resolve(json({}, { ok: false, status: 404 }));
        if (url.startsWith('/api/automation/a1/runs')) return Promise.resolve(json({ runs: [] }));
        if (url.startsWith('/api/automation/a1/usage')) return Promise.resolve(json({ usage: [], complete: true }));
        if (url.startsWith('/ai/config/tiers-for-user')) return Promise.resolve(json({ auto: { label: 'Auto' } }));
        return Promise.resolve(json({}));
    }) as never);
});

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('BuilderShell on a managed automation', () => {
    it('passes readOnly to the canvas and keeps the AI builder out', async () => {
        await mount({ forceAssistantOpen: true });
        await waitFor(() => expect(tab.readOnly).toBe(true));
        expect(tab.assistantOpen).toBe(false);
        expect(tab.onAskAssistant).toBeNull();
        expect(tab.headerProps.onAssistant).toBeNull();
        // The rail button that would open it does nothing.
        tab.setAssistantOpen(true);
        expect(tab.assistantOpen).toBe(false);
    });

    it('mounts the banner through the header strip, with Open in Dev and Stage settings', async () => {
        await mount();
        await waitFor(() => expect(tab.readOnly).toBe(true));
        render(<div>{tab.headerProps.breadcrumbSlot}</div>);
        expect(screen.getByTestId('managed-part-banner')).toHaveTextContent('Managed by Intake · Production · Release 7.');
        expect(screen.getByRole('link', { name: 'Open in Dev' })).toHaveAttribute('href', '/app/studio/automations/dev-a1');
        expect(screen.getByRole('link', { name: 'Stage settings' })).toBeInTheDocument();
        expect(screen.getByTestId('capsule')).toBeInTheDocument();
    });

    it('hands the header a row whose live state has no Make-live', async () => {
        await mount();
        await waitFor(() => expect(tab.readOnly).toBe(true));
        const live = liveStateOf(tab.headerProps.automation);
        expect(live).toMatchObject({ kind: 'live', managed: true, primary: null, canPause: true });
    });

    it('saves nothing: a canvas edit, an inspector save and a send all stop at the shell', async () => {
        await mount();
        await waitFor(() => expect(tab.readOnly).toBe(true));
        await act(async () => { tab.onVisualEdit({ ...DEF, steps: [] }); });
        await expect(tab.onSaveStep({ ...DEF, steps: [] })).rejects.toMatchObject({ status: 409, code: 'managed_part' });
        await act(async () => { await tab.onSend('add a step'); });
        await new Promise((r) => setTimeout(r, 650)); // past the 500ms visual-save debounce
        expect(puts()).toHaveLength(0);
        expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/builder/') && !String(url).includes('/session/'))).toBe(false);
    });
});

describe('BuilderShell on an unmanaged automation', () => {
    it('keeps the canvas editable, the AI builder reachable and Make-live in place', async () => {
        managed = null;
        await mount();
        await waitFor(() => expect(tab.headerProps.automation.managed).toBeNull());
        expect(tab.readOnly).toBe(false);
        expect(tab.onAskAssistant).toEqual(expect.any(Function));
        expect(tab.headerProps.onAssistant).toEqual(expect.any(Function));
        expect(liveStateOf(tab.headerProps.automation)).toMatchObject({ managed: false, primary: 'publish' });
        render(<div>{tab.headerProps.breadcrumbSlot}</div>);
        expect(screen.queryByTestId('managed-part-banner')).toBeNull();
    });

    it('a 409 managed_part on a save turns the open tab read-only and shows the banner', async () => {
        managed = null;
        await mount();
        await waitFor(() => expect(tab.readOnly).toBe(false));
        putStatus = 409;
        await act(async () => { await tab.onSaveStep({ ...DEF, steps: [] }).catch(() => {}); });
        await waitFor(() => expect(tab.readOnly).toBe(true));
        render(<div>{tab.headerProps.breadcrumbSlot}</div>);
        expect(screen.getByTestId('managed-part-banner')).toHaveTextContent('UAT.');
        expect(screen.getByRole('link', { name: 'Stage settings' })).toHaveAttribute('href', '/app/studio/solutions/s2?stage=uat&tab=settings');
    });
});
