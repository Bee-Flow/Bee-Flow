import { render as rtlRender, act, waitFor, cleanup } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * BFSF-408/409 — the run the editor starts has to CARRY the trigger's data.
 *
 * All three run routes (`/run`, `/dry-run`, `/steps/:id/run`) have read
 * `req.body.triggerPayload` since they were written. The client sent none of
 * them one, so a routine you cannot fire for real yet — a form nobody has
 * submitted, an app_event with no matching message — entered every test run
 * with `trigger.output === {}`, and each of the steps mapping off the trigger
 * resolved to undefined. That is what BFSF-409 was really reporting when it
 * asked for a second Manual trigger NODE: it needed trigger DATA.
 *
 * The payload is the primary trigger's own `pinnedOutput`, which is either a
 * captured run or something the author typed into the trigger's Output → Edit
 * sheet. Same harness as BuilderShell.stateRaces.test.jsx: mocked children hand
 * back the callbacks the real chrome would fire, `authFetch` stands in for the
 * server.
 */

vi.mock('../../../utils/helpers', () => ({ API_BASE: '', authFetch: vi.fn() }));
vi.mock('../../shared/Toast', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock('./DiagramPane', () => ({ default: () => null, applyAddNode: (d) => d }));
vi.mock('../../chat/InputArea', () => ({ default: () => null }));
vi.mock('../../admin/Studio/Executions/ExecutionsPanel', () => ({ default: () => null }));
vi.mock('./versions/VersionsTab', () => ({ default: () => null }));
vi.mock('./TriggerDiagnosePanel', () => ({ default: () => null }));
// "Run live" asks first, through the builder's in-app confirm — a promise that
// only settles when someone clicks. Auto-yes, so the test can reach the POST.
vi.mock('../../shared/useConfirm', () => ({
    default: () => ({ confirm: () => Promise.resolve(true), confirmDialog: null }),
}));

let buildTab = null;
let header = null;
vi.mock('./BuilderHeader', () => ({ default: (p) => { header = p; return null; } }));
vi.mock('./BuildTab', () => ({ default: (p) => { buildTab = p; header = p.headerProps; return null; } }));
vi.mock('./SettingsTab', () => ({ default: () => null }));

import BuilderShell from './BuilderShell.jsx';
import { queryWrapper } from '../../../test/queryWrapper';
import { authFetch } from '../../../utils/helpers';

// The hooks under this tree read through React Query, so every render needs
// a client above it — a fresh one per render, never the app singleton.
const render = (ui, options) => rtlRender(ui, { wrapper: queryWrapper(), ...options });

const ANSWERS = { name: 'Ada', email: 'ada@example.com' };

const defWithPin = (pin) => ({
    schemaVersion: 2,
    trigger: {
        id: 'trg',
        type: 'trigger',
        kind: 'form',
        label: 'Form',
        ...(pin === undefined ? {} : { pinnedOutput: pin, pinnedAt: '2026-08-31T10:00:00.000Z', pinnedSource: 'edited' }),
    },
    steps: [{ id: 's1', type: 'ai_step', label: 'Draft it', prompt: 'hi', position: { x: 0, y: 0 } }],
    edges: [{ from: 'trg', to: 's1' }],
});

let row;
let posts;

const json = (body, { ok = true, status = 200 } = {}) => ({ ok, status, json: () => Promise.resolve(body) });
const bodyOf = (url) => {
    const hit = posts.find(p => p.url === url);
    return hit ? JSON.parse(hit.body || '{}') : null;
};

const mount = async (definition) => {
    row = { id: 'a1', title: 'Intake', description: null, definition };
    render(<BuilderShell automationId="a1" onBack={() => {}} user={{ id: 'u1' }} />);
    await waitFor(() => expect(buildTab?.rootDef?.steps?.length).toBe(1));
};

describe('BuilderShell — the trigger sample rides along with every run', () => {
    beforeEach(() => {
        buildTab = null; header = null;
        posts = [];
        authFetch.mockReset();
        authFetch.mockImplementation((url, opts = {}) => {
            const method = opts.method || 'GET';
            if (method === 'POST') posts.push({ url, body: opts.body });
            if (url === '/api/automation/a1' && method === 'GET') return Promise.resolve(json({ automation: { ...row } }));
            if (url === '/api/automation/a1' && method === 'PUT') {
                row = { ...row, ...JSON.parse(opts.body) };
                return Promise.resolve(json({ automation: { ...row } }));
            }
            if (url === '/api/automation/a1/dry-run') return Promise.resolve(json({ run: { id: 'r1', status: 'success' }, steps: [] }));
            if (url === '/api/automation/a1/run') return Promise.resolve(json({ run: { id: 'r2', status: 'success' }, steps: [] }));
            if (url.includes('/steps/')) return Promise.resolve(json({ run: { id: 'r3' }, steps: [], stepRecord: null }));
            if (url === '/api/automation/_runs/active') return Promise.resolve(json({ active: [] }));
            if (url.startsWith('/api/automation/builder/session/')) return Promise.resolve(json({}, { ok: false, status: 404 }));
            if (url.startsWith('/api/automation/a1/runs')) return Promise.resolve(json({ runs: [] }));
            if (url.startsWith('/ai/config/tiers-for-user')) return Promise.resolve(json({ auto: { label: 'Auto' } }));
            return Promise.resolve(json({}));
        });
    });

    afterEach(() => { cleanup(); vi.restoreAllMocks(); });

    it('sends it on dry-run, on a live run, and on a single-step execute', async () => {
        await mount(defWithPin(ANSWERS));

        await act(async () => { await header.onDryRun(); });
        expect(bodyOf('/api/automation/a1/dry-run')).toEqual({ triggerPayload: ANSWERS });

        await act(async () => { await header.onRunLive(); });
        expect(bodyOf('/api/automation/a1/run')).toEqual({ triggerPayload: ANSWERS, test: true });

        await act(async () => { await buildTab.onExecuteStep('s1'); });
        expect(bodyOf('/api/automation/a1/steps/s1/run')).toEqual({ mode: 'only', triggerPayload: ANSWERS });
    });

    it('starts from a secondary trigger with THAT trigger\'s own sample and its id', async () => {
        // A routine with several entry points (definition.triggers[]). The
        // header's "Start from" choice hands the trigger id to onDryRun /
        // onRunLive; the body must carry the secondary's pin, not the
        // primary's, and name the trigger so the server seeds the DAG there.
        const B_PIN = { messageId: 'm1', addedLabelIds: ['Label_126'] };
        const def = {
            ...defWithPin(ANSWERS),
            triggers: [{
                id: 'trig_b', type: 'trigger', kind: 'app_event', label: 'Label commands',
                appEvent: { provider: 'gmail', event: 'label.added' },
                pinnedOutput: B_PIN, pinnedAt: '2026-09-03T10:00:00.000Z', pinnedSource: 'edited',
            }],
        };
        await mount(def);
        expect(header.triggers).toEqual([{ id: 'trig_b', label: 'Label commands', kind: 'app_event' }]);
        expect(header.primaryTriggerLabel).toBe('Form');

        await act(async () => { await header.onDryRun('trig_b'); });
        expect(bodyOf('/api/automation/a1/dry-run')).toEqual({ triggerPayload: B_PIN, triggerStepId: 'trig_b' });

        await act(async () => { await header.onRunLive('trig_b'); });
        expect(bodyOf('/api/automation/a1/run')).toEqual({ triggerPayload: B_PIN, triggerStepId: 'trig_b', test: true });

        // Null (the menu's primary choice), nothing (the hotkey) and a click
        // event (the bare Dry-run button) all mean the primary trigger.
        posts = [];
        await act(async () => { await header.onDryRun(null); });
        expect(bodyOf('/api/automation/a1/dry-run')).toEqual({ triggerPayload: ANSWERS });
        posts = [];
        await act(async () => { await header.onDryRun({ type: 'click' }); });
        expect(bodyOf('/api/automation/a1/dry-run')).toEqual({ triggerPayload: ANSWERS });
    });

    it('sends nothing extra when the trigger has no saved sample', async () => {
        // An untouched routine must post exactly what it always did — an
        // explicit `triggerPayload: null` would read to a later maintainer as
        // "deliberately empty" rather than "never set".
        await mount(defWithPin(undefined));

        await act(async () => { await header.onDryRun(); });
        expect(bodyOf('/api/automation/a1/dry-run')).toEqual({});

        await act(async () => { await buildTab.onExecuteStep('s1'); });
        expect(bodyOf('/api/automation/a1/steps/s1/run')).toEqual({ mode: 'only' });
    });

    it('lets the caller override it — the form preview submits what was typed', async () => {
        // BFSF-408(a): the trigger editor's preview posts the answers in the
        // boxes, not the stored sample, and mode 'only' keeps the 21 downstream
        // steps from firing for real.
        await mount(defWithPin(ANSWERS));
        const typed = { name: 'Grace', email: 'grace@example.com' };

        await act(async () => { await buildTab.onExecuteStep('trg', { mode: 'only', triggerPayload: typed }); });
        expect(bodyOf('/api/automation/a1/steps/trg/run')).toEqual({ mode: 'only', triggerPayload: typed });
    });
});
