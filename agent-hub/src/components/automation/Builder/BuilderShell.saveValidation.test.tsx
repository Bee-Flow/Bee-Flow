import { render as rtlRender, act, waitFor, cleanup } from '@testing-library/react';
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * BFSF-58 — the validation chip and the node badges show what the server
 * says about the definition NOW, not what the AI builder said last.
 *
 * `state.validation` used to be written only by the builder's
 * `validation_errors` event. Every save of a definition already got the
 * server's verdict back (warnings on a 200, the blocking records on a 400)
 * and threw it away, so after a manual edit a fixed problem stayed on the
 * chip, a new one never appeared, and a routine built by hand never showed a
 * chip at all. These drive the three save paths — the debounced canvas save,
 * the step inspector and the Settings tab — and read the state the chip and
 * the badges are rendered from.
 *
 * Children are mocked the way BuilderShell.stateRaces.test.jsx does it;
 * `authFetch` stands in for the server.
 */

type Definition = { steps: Array<Record<string, unknown>>; [key: string]: unknown };
type Validation = { errors: unknown[]; warnings: unknown[] } | null;
interface HeaderProps { onTabChange: (tab: string) => void; onRename: (title: string) => Promise<void> }
interface BuildTabProps {
    state: { validation: Validation };
    scopedDef: Definition;
    rootDef: Definition;
    onVisualEdit: (next: Definition) => void;
    onSaveStep: (next: Definition) => Promise<void>;
    headerProps: HeaderProps;
}
interface SettingsProps { onSave: (patch: Record<string, unknown>) => Promise<void> }

vi.mock('../../../utils/helpers', () => ({ API_BASE: '', authFetch: vi.fn() }));
vi.mock('../../shared/Toast', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock('./DiagramPane', () => ({ default: () => null, applyAddNode: (d: unknown) => d }));
vi.mock('../../chat/InputArea', () => ({ default: () => null }));
vi.mock('../../admin/Studio/Executions/ExecutionsPanel', () => ({ default: () => null }));
vi.mock('./versions/VersionsTab', () => ({ default: () => null }));
vi.mock('./TriggerDiagnosePanel', () => ({ default: () => null }));

let buildTab: BuildTabProps | null = null;
let header: HeaderProps | null = null;
let settings: SettingsProps | null = null;
vi.mock('./BuilderHeader', () => ({ default: (p: HeaderProps) => { header = p; return null; } }));
vi.mock('./BuildTab', () => ({ default: (p: BuildTabProps) => { buildTab = p; header = p.headerProps; return null; } }));
vi.mock('./SettingsTab', () => ({ default: (p: SettingsProps) => { settings = p; return null; } }));

import BuilderShell from './BuilderShell.jsx';
import { queryWrapper } from '../../../test/queryWrapper';
import { authFetch } from '../../../utils/helpers';

const mockedFetch = vi.mocked(authFetch);
const render = (ui: React.ReactElement) => rtlRender(ui, { wrapper: queryWrapper() });

const D0 = (): Definition => ({
    schemaVersion: 2,
    trigger: { id: 'trg', type: 'trigger', kind: 'manual', label: 'Manually' },
    steps: [{ id: 's1', type: 'ai_step', label: 'Draft it', prompt: 'hi', position: { x: 0, y: 0 } }],
    edges: [{ from: 'trg', to: 's1' }],
});

const WARNING = { code: 'condition.dead_branch', message: 'Step s1: the else branch goes nowhere.', path: 'steps[s1]' };
const ERROR = { code: 'switch.cases_missing', message: 'Step s1: switch requires at least one case.', path: 'steps[s1].cases' };

let row: { id: string; title: string; description: string | null; definition: Definition };
// What the next PUT answers: warnings on success, or a 400 with records.
let nextPut: { warnings?: unknown[]; reject?: unknown[] };

const json = (body: unknown, { ok = true, status = 200 } = {}) =>
    ({ ok, status, statusText: ok ? 'OK' : 'Bad Request', json: () => Promise.resolve(body) }) as unknown as Response;

const flushDebouncedSave = async () => {
    await act(async () => { await new Promise(r => setTimeout(r, 600)); });
};

const tab = (): BuildTabProps => {
    if (!buildTab) throw new Error('BuildTab has not rendered');
    return buildTab;
};

const mountShell = async () => {
    render(<BuilderShell automationId="a1" onBack={() => {}} user={{ id: 'u1' }} />);
    await waitFor(() => expect(buildTab?.rootDef?.steps?.length).toBe(1));
};

const moveNode = (x: number) => {
    const def = tab().scopedDef;
    act(() => { tab().onVisualEdit({ ...def, steps: [{ ...def.steps[0], position: { x, y: 0 } }] }); });
};

describe('BuilderShell — the chip follows the server after a manual save (BFSF-58)', () => {
    beforeEach(() => {
        buildTab = null; header = null; settings = null;
        row = { id: 'a1', title: 'Weekly digest', description: null, definition: D0() };
        nextPut = { warnings: [] };
        mockedFetch.mockReset();
        mockedFetch.mockImplementation((url: string, opts: RequestInit = {}) => {
            const method = opts.method || 'GET';
            if (url === '/api/automation/a1' && method === 'GET') return Promise.resolve(json({ automation: { ...row } }));
            if (url === '/api/automation/a1' && method === 'PUT') {
                if (nextPut.reject) return Promise.resolve(json({ error: 'Invalid definition', details: nextPut.reject }, { ok: false, status: 400 }));
                const body = JSON.parse(String(opts.body));
                row = { ...row, ...body };
                // Like the real route: a verdict only when a definition was sent.
                return Promise.resolve(json({ automation: { ...row }, warnings: body.definition ? nextPut.warnings : [] }));
            }
            if (url === '/api/automation/_runs/active') return Promise.resolve(json({ active: [] }));
            if (url.startsWith('/api/automation/builder/session/')) return Promise.resolve(json({}, { ok: false, status: 404 }));
            if (url.startsWith('/api/automation/a1/runs')) return Promise.resolve(json({ runs: [] }));
            if (url.startsWith('/ai/config/tiers-for-user')) return Promise.resolve(json({ auto: { label: 'Auto' } }));
            return Promise.resolve(json({}));
        });
    });

    afterEach(() => { cleanup(); });

    it('a canvas save shows the warnings it came back with, and a clean one clears them', async () => {
        await mountShell();
        expect(tab().state.validation).toBeNull();

        nextPut = { warnings: [WARNING] };
        moveNode(100);
        await flushDebouncedSave();
        expect(tab().state.validation).toEqual({ errors: [], warnings: [WARNING] });

        nextPut = { warnings: [] };
        moveNode(200);
        await flushDebouncedSave();
        expect(tab().state.validation).toEqual({ errors: [], warnings: [] });
    });

    it('a canvas save the server refuses shows its records as errors', async () => {
        await mountShell();
        nextPut = { reject: [ERROR] };
        moveNode(100);
        await flushDebouncedSave();
        expect(tab().state.validation).toEqual({ errors: [ERROR], warnings: [] });
    });

    it('the step inspector save adopts the verdict too, and still throws a refusal', async () => {
        await mountShell();
        const edited = (prompt: string) => ({ ...tab().scopedDef, steps: [{ ...tab().scopedDef.steps[0], prompt }] });

        nextPut = { warnings: [WARNING] };
        await act(async () => { await tab().onSaveStep(edited('one')); });
        expect(tab().state.validation).toEqual({ errors: [], warnings: [WARNING] });

        nextPut = { reject: [ERROR] };
        let thrown: unknown = null;
        await act(async () => {
            try { await tab().onSaveStep(edited('two')); } catch (e) { thrown = e; }
        });
        expect(thrown).toBeTruthy();
        expect(tab().state.validation).toEqual({ errors: [ERROR], warnings: [] });
    });

    it('a Settings save with a definition adopts it; a rename leaves the chip alone', async () => {
        await mountShell();
        act(() => { header?.onTabChange('settings'); });
        await waitFor(() => expect(settings).toBeTruthy());

        nextPut = { warnings: [WARNING] };
        await act(async () => { await settings?.onSave({ title: 'Weekly digest', description: null, definition: row.definition }); });
        act(() => { header?.onTabChange('build'); });
        await waitFor(() => expect(tab().state.validation).toEqual({ errors: [], warnings: [WARNING] }));

        await act(async () => { await header?.onRename('Renamed'); });
        expect(tab().state.validation).toEqual({ errors: [], warnings: [WARNING] });
    });
});
