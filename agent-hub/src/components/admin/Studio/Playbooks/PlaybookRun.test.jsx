import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import PlaybookRun from './PlaybookRun';
import { playbooksApi } from './playbooksApi';
import { setCurrentUser, setItem } from '../../../../utils/scopedStorage';

/**
 * The run page drives the two builders and reports back with CAS writes.
 * Everything a phase presses is asserted as the exact wire body, because
 * the server validates transitions and a wrong body is a 409 the person
 * reads as "it broke". The builders are mocked to what the page needs from
 * them: their props, and a way to end a turn.
 */

vi.mock('./playbooksApi', () => {
    const playbooksApi = { get: vi.fn(), patch: vi.fn(), runPhase: vi.fn(), skipPhase: vi.fn(), retryPhase: vi.fn(), list: vi.fn(), create: vi.fn(), recipes: vi.fn(), remove: vi.fn() };
    return { playbooksApi, default: playbooksApi };
});

const shellProps = vi.fn();
vi.mock('../../../automation/Builder/BuilderShell', () => ({
    default: (props) => {
        shellProps(props);
        return (
            <div data-testid="builder-shell" data-automation={props.automationId || ''} data-autosend={props.autoSendInput || ''} data-tier={props.forcedTier || ''} data-back={props.backLabel || ''}>
                <button type="button" onClick={() => props.onAutomationIdResolved?.('auto_1')}>resolve</button>
                <button type="button" onClick={() => props.onTurnEnd?.({ finalized: true, aborted: false, error: null, automationId: 'auto_1', messageCount: 2 })}>finalize</button>
                <button type="button" onClick={() => props.onTurnEnd?.({ finalized: false, aborted: true, error: null, automationId: 'auto_1', messageCount: 2 })}>abort</button>
                <button type="button" onClick={() => props.onTurnEnd?.({ finalized: false, aborted: false, error: null, automationId: 'auto_1', messageCount: 2 })}>ask</button>
            </div>
        );
    },
}));

const paneProps = vi.fn();
vi.mock('../AppStudio/chat/BuilderChatPane', () => ({
    default: (props) => {
        paneProps(props);
        return (
            <div data-testid="builder-pane" data-autosend={props.autoSend || ''} data-tier={props.forcedTier || ''}>
                <button type="button" onClick={() => props.onTurnEnd?.({ finalized: true, stopped: false, awaitingPlan: false, error: null, code: null })}>finalize-app</button>
                <button type="button" onClick={() => props.onTurnEnd?.({ finalized: false, stopped: false, awaitingPlan: false, error: new Error('boom'), code: 'model_empty_reply' })}>fail-app</button>
            </div>
        );
    },
}));
vi.mock('../AppStudio/editor/AppEditorShell', () => ({
    default: ({ app, chatSlot }) => <div data-testid="app-shell" data-app={app.id}>{chatSlot}</div>,
}));
vi.mock('../AppStudio/studioAppsApi', () => ({
    studioAppsApi: { getApp: vi.fn(async (id) => ({ app: { id, name: 'Facturen' } })) },
}));
const getRunSteps = vi.fn(async () => ({ steps: [{ stepId: 's1', status: 'completed', kind: 'nextcloud_list_files' }], definition: null }));
const getAutomation = vi.fn(async () => ({ automation: { id: 'auto_1', title: 'Facturen inlezen', definition: { steps: [{}, {}, {}, {}] } } }));
vi.mock('../../../../hooks/useAutomationApi', () => ({ default: () => ({ getRunSteps, getAutomation }) }));
// The fill stage is the FLOW plus the table now — no step list, no counter column.
vi.mock('../../../automation/Builder/RunExecutionView', () => ({ default: ({ steps }) => <div data-testid="run-canvas" data-n={steps.length} /> }));
vi.mock('../../../../hooks/useReducedMotion', () => ({ useReducedMotion: () => true }));

const PHASES = ['table', 'routine', 'fill', 'app', 'approvals'];
function pb(overrides = {}, phaseOverrides = {}) {
    const phases = PHASES.map((key) => ({ key, status: 'pending', attempt: 0, brief: null, artifacts: {}, summary: null, error: null, ...(phaseOverrides[key] || {}) }));
    return { id: 'pb_1', title: 'Facturen bijhouden', recipeId: 'invoice_tracker', status: 'active', version: 3, options: { tier: 'fast', tableMode: 'new' }, currentPhase: 'table', phases, ...overrides };
}
const TABLE_ART = { datatableId: 'tbl_1', datatableKey: 'facturen', datatableName: 'Facturen', fields: [{ key: 'datum', name: 'Datum', type: 'date' }, { key: 'totaal', name: 'Totaal', type: 'number' }], mapping: { datum: 'datum', totaal: 'totaal' }, hasStatus: true, rowCount: 0 };

function renderRun(props = {}) {
    return render(<PlaybookRun playbookId="pb_1" user={{ id: 'u1' }} onBack={vi.fn()} onNavigate={vi.fn()} {...props} />);
}

beforeEach(() => {
    vi.resetAllMocks(); // once-queues too — a failed test must not feed the next
    setCurrentUser('u1');
    setItem('playbooks.autopilot', '0');
});
afterEach(() => cleanup());

describe('PlaybookRun — the table phase and the handoff', () => {
    it('starts a ready table phase by POSTing run, then shows the columns and the handoff with the NEXT brief', async () => {
        playbooksApi.get.mockResolvedValue({ playbook: pb({}, { table: { status: 'ready' } }) });
        const landed = pb({ version: 4, currentPhase: 'table' }, {
            table: { status: 'awaiting', artifacts: TABLE_ART, summary: 'Tabel "Facturen" aangemaakt met 8 kolommen.', startedAt: '2026-09-13T10:00:00Z', finishedAt: '2026-09-13T10:00:02Z' },
            routine: { status: 'pending', brief: 'Build a routine on tbl_1' },
        });
        playbooksApi.runPhase.mockResolvedValue({ playbook: landed });
        renderRun();
        await waitFor(() => expect(playbooksApi.runPhase).toHaveBeenCalledWith('pb_1', 'table', {}));
        expect(await screen.findByTestId('playbook-handoff')).toBeTruthy();
        expect(screen.getAllByTestId('playbook-table-column')).toHaveLength(2);
        // The brief is READ rendered; the textarea is one click away.
        expect(screen.getByTestId('playbook-brief-preview').textContent).toContain('Build a routine on tbl_1');
        fireEvent.click(screen.getByTestId('playbook-brief-edit'));
        expect(screen.getByTestId('playbook-next-brief').value).toBe('Build a routine on tbl_1');
        expect(screen.getByTestId('playbook-phase-table').getAttribute('data-status')).toBe('awaiting');

        // Continue without touching the brief: ONE entry — the server keeps its own brief.
        playbooksApi.patch.mockResolvedValue({ playbook: pb({ version: 5 }, { table: { status: 'done', artifacts: TABLE_ART }, routine: { status: 'ready', brief: 'Build a routine on tbl_1' } }) });
        fireEvent.click(screen.getByTestId('playbook-continue'));
        await waitFor(() => expect(playbooksApi.patch).toHaveBeenCalledWith('pb_1', { expectedVersion: 4, phases: [{ key: 'table', status: 'done' }] }));
    });

    it('an edited brief rides in the same CAS write as the done', async () => {
        playbooksApi.get.mockResolvedValue({ playbook: pb({ version: 4 }, { table: { status: 'awaiting', artifacts: TABLE_ART }, routine: { status: 'pending', brief: 'old brief' } }) });
        playbooksApi.patch.mockResolvedValue({ playbook: pb({ version: 5 }, { table: { status: 'done' }, routine: { status: 'ready', brief: 'new brief' } }) });
        renderRun();
        fireEvent.click(await screen.findByTestId('playbook-brief-edit'));
        const ta = screen.getByTestId('playbook-next-brief');
        fireEvent.change(ta, { target: { value: 'new brief' } });
        fireEvent.click(screen.getByTestId('playbook-continue'));
        await waitFor(() => expect(playbooksApi.patch).toHaveBeenCalledWith('pb_1', { expectedVersion: 4, phases: [{ key: 'table', status: 'done' }, { key: 'routine', brief: 'new brief' }] }));
    });

    it('a 409 reloads the entity and says so, never retries', async () => {
        playbooksApi.get.mockResolvedValue({ playbook: pb({ version: 4 }, { table: { status: 'awaiting', artifacts: TABLE_ART }, routine: { status: 'pending', brief: 'b' } }) });
        const err = Object.assign(new Error('This playbook changed elsewhere.'), { status: 409, code: 'version_conflict', body: { playbook: pb({ version: 9 }, { table: { status: 'done' }, routine: { status: 'running', brief: 'b', artifacts: { automationId: 'auto_9' } } }) } });
        playbooksApi.patch.mockRejectedValueOnce(err);
        renderRun();
        fireEvent.click(await screen.findByTestId('playbook-continue'));
        await screen.findByText(/changed elsewhere/);
        expect(playbooksApi.patch).toHaveBeenCalledTimes(1);
        // The reloaded entity is what the page shows now: routine running.
        expect(screen.getByTestId('playbook-phase-routine').getAttribute('data-status')).toBe('running');
    });
});

describe('PlaybookRun — the routine phase drives the routine builder', () => {
    it('PATCHes running BEFORE the shell mounts, hands the brief as autoSendInput with the pinned tier, records the routine id and the finalized turn', async () => {
        let resolvePatch;
        playbooksApi.get.mockResolvedValue({ playbook: pb({ version: 5 }, { table: { status: 'done', artifacts: TABLE_ART }, routine: { status: 'ready', brief: 'Build a routine on tbl_1' } }) });
        playbooksApi.patch.mockImplementationOnce(() => new Promise((r) => { resolvePatch = r; }));
        renderRun();
        await waitFor(() => expect(playbooksApi.patch).toHaveBeenCalledWith('pb_1', { expectedVersion: 5, phases: [{ key: 'routine', status: 'running' }] }));
        // NOT mounted until the server confirmed: a reload mid-PATCH must land on running, never fire the brief twice.
        expect(screen.queryByTestId('builder-shell')).toBeNull();
        await act(async () => { resolvePatch({ playbook: pb({ version: 6 }, { table: { status: 'done', artifacts: TABLE_ART }, routine: { status: 'running', brief: 'Build a routine on tbl_1', startedAt: '2026-09-13T10:00:00Z' } }) }); });
        const shell = await screen.findByTestId('builder-shell');
        expect(shell.getAttribute('data-autosend')).toBe('Build a routine on tbl_1');
        expect(shell.getAttribute('data-tier')).toBe('fast');
        expect(shell.getAttribute('data-automation')).toBe('');
        expect(shellProps.mock.calls.at(-1)[0].onOpenList).toBeNull();
        // The run page has its own back arrow, and it goes somewhere else; the
        // builder's would have sat beside it, mislabelled.
        expect(shellProps.mock.calls.at(-1)[0].onBack).toBeNull();
        // The brief is auto-sent into this pane, so it has to be visible. The
        // preference it normally reads defaults to CLOSED.
        expect(shellProps.mock.calls.at(-1)[0].forceAssistantOpen).toBe(true);

        // The builder created the routine: one artifact write.
        playbooksApi.patch.mockResolvedValueOnce({ playbook: pb({ version: 7 }, { table: { status: 'done', artifacts: TABLE_ART }, routine: { status: 'running', brief: 'Build a routine on tbl_1', artifacts: { automationId: 'auto_1' } } }) });
        fireEvent.click(screen.getByText('resolve'));
        await waitFor(() => expect(playbooksApi.patch).toHaveBeenLastCalledWith('pb_1', { expectedVersion: 6, phases: [{ key: 'routine', artifacts: { automationId: 'auto_1' } }] }));

        // The turn finalized: awaiting, with the title for the rail.
        playbooksApi.patch.mockResolvedValueOnce({ playbook: pb({ version: 8 }, { table: { status: 'done', artifacts: TABLE_ART }, routine: { status: 'awaiting', artifacts: { automationId: 'auto_1', automationTitle: 'Facturen inlezen' }, summary: 'Automation "Facturen inlezen" ready · 4 steps' }, fill: { status: 'pending' } }) });
        fireEvent.click(screen.getByText('finalize'));
        await waitFor(() => expect(playbooksApi.patch).toHaveBeenLastCalledWith('pb_1', {
            expectedVersion: 7,
            phases: [{ key: 'routine', status: 'awaiting', summary: 'Automation "Facturen inlezen" ready · 4 steps', artifacts: { automationId: 'auto_1', automationTitle: 'Facturen inlezen' } }],
        }));
        expect(await screen.findByTestId('playbook-handoff')).toBeTruthy();
        expect(screen.getByTestId('playbook-phase-routine').textContent).toContain('Automation "Facturen inlezen"');
    });

    it('an aborted turn fails the phase; Retry POSTs retry with the version; a question shows the needs-input face with Mark as done', async () => {
        const running = pb({ version: 6 }, { table: { status: 'done', artifacts: TABLE_ART }, routine: { status: 'running', brief: 'b', artifacts: { automationId: 'auto_1' } } });
        playbooksApi.get.mockResolvedValue({ playbook: running });
        renderRun();
        await screen.findByTestId('builder-shell');
        fireEvent.click(screen.getByText('ask'));
        const card = await screen.findByTestId('playbook-handoff');
        expect(card.getAttribute('data-face')).toBe('needs_input');
        expect(screen.getByTestId('playbook-mark-done')).toBeTruthy();
        expect(playbooksApi.patch).not.toHaveBeenCalled();

        playbooksApi.patch.mockResolvedValueOnce({ playbook: pb({ version: 7 }, { table: { status: 'done', artifacts: TABLE_ART }, routine: { status: 'failed', error: 'aborted', artifacts: { automationId: 'auto_1' } } }) });
        fireEvent.click(screen.getByText('abort'));
        await waitFor(() => expect(playbooksApi.patch).toHaveBeenLastCalledWith('pb_1', { expectedVersion: 6, phases: [{ key: 'routine', status: 'failed', error: 'aborted' }] }));
        expect((await screen.findByTestId('playbook-handoff')).getAttribute('data-face')).toBe('failed');
        expect(screen.getByText('The builder stopped before it finished.')).toBeTruthy();

        playbooksApi.retryPhase.mockResolvedValueOnce({ playbook: pb({ version: 8 }, { table: { status: 'done', artifacts: TABLE_ART }, routine: { status: 'ready', attempt: 1, brief: 'b', artifacts: { automationId: 'auto_1' } } }) });
        playbooksApi.patch.mockResolvedValueOnce({ playbook: pb({ version: 9 }, { table: { status: 'done', artifacts: TABLE_ART }, routine: { status: 'running', attempt: 1, brief: 'b', artifacts: { automationId: 'auto_1' } } }) });
        fireEvent.click(screen.getByTestId('playbook-retry'));
        await waitFor(() => expect(playbooksApi.retryPhase).toHaveBeenCalledWith('pb_1', 'routine', 7, {}));
        // A retry on an EXISTING routine prefills instead of auto-firing.
        await waitFor(() => expect(screen.getByTestId('builder-shell').getAttribute('data-automation')).toBe('auto_1'));
        expect(screen.getByTestId('builder-shell').getAttribute('data-autosend')).toBe('');
        expect(shellProps.mock.calls.at(-1)[0].initialChatInput).toBe('b');
        // …and the person drives the chat, so Mark as done is on offer at once.
        expect((await screen.findByTestId('playbook-handoff')).getAttribute('data-face')).toBe('needs_input');
        fireEvent.click(screen.getByTestId('playbook-dismiss'));
        expect(screen.queryByTestId('playbook-handoff')).toBeNull();
    });

    it('a stopped playbook resumes: PATCH status active; the interrupted phase comes back failed with Retry', async () => {
        playbooksApi.get.mockResolvedValue({ playbook: pb({ version: 7, status: 'stopped' }, { table: { status: 'done', artifacts: TABLE_ART }, routine: { status: 'running', brief: 'b', artifacts: { automationId: 'auto_1', automationTitle: 'Facturen inlezen' } } }) });
        playbooksApi.patch.mockResolvedValueOnce({ playbook: pb({ version: 8 }, { table: { status: 'done', artifacts: TABLE_ART }, routine: { status: 'failed', error: 'interrupted', brief: 'b', artifacts: { automationId: 'auto_1', automationTitle: 'Facturen inlezen' } } }) });
        renderRun();
        const done = await screen.findByTestId('playbook-done');
        expect(done.textContent).toContain('stopped mid-build');
        fireEvent.click(screen.getByTestId('playbook-resume'));
        await waitFor(() => expect(playbooksApi.patch).toHaveBeenCalledWith('pb_1', { expectedVersion: 7, status: 'active' }));
        const card = await screen.findByTestId('playbook-handoff');
        expect(card.getAttribute('data-face')).toBe('failed');
        expect(card.textContent).toContain('Stopped mid-build.');
        expect(screen.getByTestId('playbook-retry')).toBeTruthy();
    });
});

describe('PlaybookRun — a design redrawn on request', () => {
    // The app's brief carries the design. When the person asks the designer
    // for something else, the brief the builder is about to get changes under
    // the handoff card — and the card used to keep showing (and sending back)
    // the one it first rendered, so the builder was handed the design that had
    // just been replaced (owner, 2026-09-16).
    const withDesign = (over = {}, phaseOver = {}) => {
        const phases = [
            { key: 'table', kind: 'table', status: 'done', attempt: 0, artifacts: TABLE_ART, brief: null, summary: null, error: null },
            { key: 'design', kind: 'design', status: 'awaiting', attempt: 0, brief: null, summary: 'Design "Invoice Intelligence": 2 screens.', error: null, artifacts: { design: { name: 'Invoice Intelligence', tagline: '', look: { preset: 'cloud', accent: '#1e7f4f', mood: '' }, screens: [{ name: 'Dashboard', purpose: '', sections: [{ title: 'Key figures', layout: 'row', elements: [{ kind: 'stat', label: 'Total' }] }] }, { name: 'Invoice Details', purpose: '', sections: [{ title: 'Details', layout: 'stack', elements: [{ kind: 'detail', label: 'Invoice' }] }] }], principles: [] }, designName: 'Invoice Intelligence', screenCount: 2, elementCount: 2 }, ...(phaseOver.design || {}) },
            { key: 'app', kind: 'app', status: 'pending', attempt: 0, brief: 'Build the app.\n\nDESIGN: Screen "Dashboard". Screen "Invoice Details".', artifacts: { appId: 'app_1' }, summary: null, error: null, ...(phaseOver.app || {}) },
        ];
        return { id: 'pb_1', title: 'Invoice Intelligence Dashboard', recipeId: 'custom', status: 'active', version: 4, options: { tier: 'fast', tableMode: 'new' }, currentPhase: 'design', phases, ...over };
    };

    it('the redrawn design reaches the builder: the card follows the recomposed brief instead of sending the old one back', async () => {
        playbooksApi.get.mockResolvedValue({ playbook: withDesign() });
        renderRun();
        fireEvent.click(await screen.findByTestId('playbook-brief-edit'));
        const box = screen.getByTestId('playbook-next-brief');
        expect(box.value).toContain('Screen "Invoice Details"');

        // Ask for the change; the server answers with the new design AND the
        // app's brief recomposed around it.
        const redrawn = withDesign({ version: 5 }, {
            design: { artifacts: { design: { name: 'Invoice Intelligence', tagline: '', look: { preset: 'cloud', accent: '#1e7f4f', mood: '' }, screens: [{ name: 'Dashboard', purpose: '', sections: [{ title: 'Key figures', layout: 'row', elements: [{ kind: 'stat', label: 'Total' }] }] }], principles: [] }, designName: 'Invoice Intelligence', screenCount: 1, elementCount: 1, revisions: ['Drop the details screen'] } },
            app: { brief: 'Build the app.\n\nDESIGN: Screen "Dashboard".' },
        });
        playbooksApi.runPhase.mockResolvedValue({ playbook: redrawn });
        fireEvent.change(screen.getByTestId('playbook-design-revise-input'), { target: { value: 'Drop the details screen' } });
        fireEvent.click(screen.getByTestId('playbook-design-revise-send'));
        await waitFor(() => expect(playbooksApi.runPhase).toHaveBeenCalledWith('pb_1', 'design', { feedback: 'Drop the details screen' }));

        // The box now holds the brief the server composed — not the old one.
        await waitFor(() => expect(screen.getByTestId('playbook-next-brief').value).toBe('Build the app.\n\nDESIGN: Screen "Dashboard".'));
        expect(screen.getByTestId('playbook-next-brief').value).not.toContain('Invoice Details');

        // …so Continue sends ONE entry: nothing was edited by hand.
        playbooksApi.patch.mockResolvedValue({ playbook: redrawn });
        fireEvent.click(screen.getByTestId('playbook-continue'));
        await waitFor(() => expect(playbooksApi.patch).toHaveBeenCalledWith('pb_1', { expectedVersion: 5, phases: [{ key: 'design', status: 'done' }] }));
    });

    it('what the person types in the box still wins until the server changes the brief again', async () => {
        playbooksApi.get.mockResolvedValue({ playbook: withDesign() });
        playbooksApi.patch.mockResolvedValue({ playbook: withDesign({ version: 5 }) });
        renderRun();
        fireEvent.click(await screen.findByTestId('playbook-brief-edit'));
        const box = screen.getByTestId('playbook-next-brief');
        fireEvent.change(box, { target: { value: 'My own brief' } });
        fireEvent.click(screen.getByTestId('playbook-continue'));
        await waitFor(() => expect(playbooksApi.patch).toHaveBeenCalledWith('pb_1', { expectedVersion: 4, phases: [{ key: 'design', status: 'done' }, { key: 'app', brief: 'My own brief' }] }));
    });
});

describe('PlaybookRun — the phase inspector and the rail', () => {
    it('a phase in the rail opens its details beside the stage, and the stage underneath is never unmounted', async () => {
        const running = pb({ version: 6 }, {
            table: { status: 'done', artifacts: TABLE_ART, summary: 'Tabel "Facturen" aangemaakt met 8 kolommen.', startedAt: '2026-09-13T10:00:00Z', finishedAt: '2026-09-13T10:00:02Z' },
            routine: { status: 'running', brief: 'Build an automation on tbl_1', artifacts: { automationId: 'auto_1' } },
        });
        playbooksApi.get.mockResolvedValue({ playbook: running });
        renderRun();
        await screen.findByTestId('builder-shell');
        expect(screen.queryByTestId('playbook-inspector')).toBeNull();

        fireEvent.click(screen.getByTestId('playbook-phase-open-table'));
        const panel = await screen.findByTestId('playbook-inspector');
        expect(panel.getAttribute('data-phase')).toBe('table');
        expect(panel.textContent).toContain('Tabel "Facturen" aangemaakt met 8 kolommen.');
        expect(panel.textContent).toContain('Facturen');       // the table it made
        expect(panel.textContent).toContain('facturen');       // its key
        expect(panel.textContent).toContain('Took 2s');
        expect(screen.getByTestId('playbook-inspector-columns').textContent).toContain('Datum');
        // The builder of the RUNNING phase kept its mount — its stream would die with it.
        expect(screen.getByTestId('builder-shell')).toBeTruthy();
        expect(shellProps).toHaveBeenCalledTimes(shellProps.mock.calls.length);

        // The brief of a phase that has not run is there to read before it does.
        fireEvent.click(screen.getByTestId('playbook-phase-open-routine'));
        await waitFor(() => expect(screen.getByTestId('playbook-inspector').getAttribute('data-phase')).toBe('routine'));
        expect(screen.getByTestId('playbook-inspector-brief').textContent).toBe('Build an automation on tbl_1');

        // Clicking the same phase again closes it; so does the X.
        fireEvent.click(screen.getByTestId('playbook-phase-open-routine'));
        await waitFor(() => expect(screen.queryByTestId('playbook-inspector')).toBeNull());
        fireEvent.click(screen.getByTestId('playbook-phase-open-table'));
        fireEvent.click(await screen.findByTestId('playbook-inspector-close'));
        await waitFor(() => expect(screen.queryByTestId('playbook-inspector')).toBeNull());
    });

    it('the rail folds to its circles while the rows are arriving, and a press pins it open', async () => {
        const filling = pb({ version: 6 }, {
            table: { status: 'done', artifacts: TABLE_ART },
            routine: { status: 'done', artifacts: { automationId: 'auto_1' } },
            fill: { status: 'running', artifacts: { runId: 'run_1', rowsBefore: 0 } },
        });
        playbooksApi.get.mockResolvedValue({ playbook: filling });
        renderRun();
        await screen.findByTestId('run-canvas');
        expect(screen.getByTestId('playbook-rail-aside').getAttribute('data-collapsed')).toBe('1');
        expect(screen.getByTestId('playbook-rail').getAttribute('data-collapsed')).toBe('1');
        // Still the way into a phase's details.
        fireEvent.click(screen.getByTestId('playbook-phase-open-table'));
        expect(await screen.findByTestId('playbook-inspector')).toBeTruthy();
        // And it opens on request, for the rest of the run.
        fireEvent.click(screen.getByTestId('playbook-rail-toggle'));
        await waitFor(() => expect(screen.getByTestId('playbook-rail-aside').getAttribute('data-collapsed')).toBeNull());
    });
});

describe('PlaybookRun — fill, app, approvals, done', () => {
    it('fill: polls the run steps while running and shows the row count when it lands', async () => {
        const running = pb({ version: 6 }, { table: { status: 'done', artifacts: TABLE_ART }, routine: { status: 'done', artifacts: { automationId: 'auto_1' } }, fill: { status: 'running', artifacts: { runId: 'run_1', rowsBefore: 0 } } });
        const landed = pb({ version: 7 }, { table: { status: 'done', artifacts: TABLE_ART }, routine: { status: 'done', artifacts: { automationId: 'auto_1' } }, fill: { status: 'awaiting', artifacts: { runId: 'run_1', rowsBefore: 0, rowCount: 32, runStatus: 'success' }, summary: '32 rijen toegevoegd' }, app: { status: 'pending', brief: 'Build an app', artifacts: { appId: 'app_1' } } });
        playbooksApi.get.mockResolvedValueOnce({ playbook: running }).mockResolvedValue({ playbook: landed });
        renderRun();
        await screen.findByTestId('run-canvas');
        await waitFor(() => expect(screen.getByTestId('run-canvas').getAttribute('data-n')).toBe('1'));
        expect(getRunSteps).toHaveBeenCalledWith('run_1');
        // The 2 s poll brings the landing; reduced motion shows the number at once.
        await waitFor(() => expect(screen.getByTestId('playbook-row-counter').textContent).toBe('32'), { timeout: 4000 });
        expect(screen.getByText('32 rows · done')).toBeTruthy();
        expect(screen.getByText('+32 this run')).toBeTruthy();
    });

    it('app: opens the pre-created app, PATCHes running, the pane sees the brief ONCE with the pinned tier; the finalized turn lands awaiting with the app name', async () => {
        const ready = pb({ version: 8 }, { table: { status: 'done', artifacts: TABLE_ART }, routine: { status: 'done' }, fill: { status: 'done' }, app: { status: 'ready', brief: 'Build an app on tbl_1', artifacts: { appId: 'app_1' } } });
        playbooksApi.get.mockResolvedValue({ playbook: ready });
        playbooksApi.patch
            .mockResolvedValueOnce({ playbook: pb({ version: 9 }, { table: { status: 'done', artifacts: TABLE_ART }, routine: { status: 'done' }, fill: { status: 'done' }, app: { status: 'running', brief: 'Build an app on tbl_1', artifacts: { appId: 'app_1' } } }) })
            // The stamp write's answer: this attempt's brief went out.
            .mockResolvedValueOnce({ playbook: pb({ version: 10 }, { table: { status: 'done', artifacts: TABLE_ART }, routine: { status: 'done' }, fill: { status: 'done' }, app: { status: 'running', brief: 'Build an app on tbl_1', artifacts: { appId: 'app_1', briefSentAttempt: 0, briefSentAt: 'x' } } }) });
        renderRun();
        await waitFor(() => expect(playbooksApi.patch).toHaveBeenCalledWith('pb_1', { expectedVersion: 8, phases: [{ key: 'app', status: 'running' }] }));
        await screen.findByTestId('builder-pane');
        expect(screen.getByTestId('app-shell').getAttribute('data-app')).toBe('app_1');
        // The pane's FIRST render carries the brief (its autosend effect fires
        // on that render); the stamp write then clears it so a reload of the
        // same attempt sends nothing.
        expect(paneProps.mock.calls[0][0]).toMatchObject({ appId: 'app_1', autoSend: 'Build an app on tbl_1', forcedTier: 'fast' });
        await waitFor(() => expect(playbooksApi.patch.mock.calls.at(-1)[1].phases[0].artifacts).toMatchObject({ briefSentAttempt: 0 }));
        await waitFor(() => expect(screen.getByTestId('builder-pane').getAttribute('data-autosend')).toBe(''));

        playbooksApi.patch.mockResolvedValueOnce({ playbook: pb({ version: 11 }, { table: { status: 'done', artifacts: TABLE_ART }, routine: { status: 'done' }, fill: { status: 'done' }, app: { status: 'awaiting', artifacts: { appId: 'app_1', appName: 'Facturen' }, summary: 'App "Facturen" built.' }, approvals: { status: 'locked' } }) });
        fireEvent.click(screen.getByText('finalize-app'));
        await waitFor(() => expect(playbooksApi.patch).toHaveBeenLastCalledWith('pb_1', { expectedVersion: 10, phases: [{ key: 'app', status: 'awaiting', summary: 'App "Facturen" built.', artifacts: { appId: 'app_1', appName: 'Facturen' } }] }));
        // Approvals is locked: nothing pending after app → the card says Finish.
        expect((await screen.findByTestId('playbook-continue')).textContent).toContain('Finish');
        playbooksApi.patch.mockResolvedValueOnce({ playbook: pb({ version: 12, status: 'done' }, { table: { status: 'done', artifacts: TABLE_ART }, routine: { status: 'done', artifacts: { automationId: 'auto_1', automationTitle: 'Facturen inlezen' } }, fill: { status: 'done', artifacts: { rowCount: 32 } }, app: { status: 'done', artifacts: { appId: 'app_1', appName: 'Facturen' } }, approvals: { status: 'locked' } }) });
        fireEvent.click(screen.getByTestId('playbook-continue'));
        await waitFor(() => expect(playbooksApi.patch).toHaveBeenLastCalledWith('pb_1', { expectedVersion: 11, phases: [{ key: 'app', status: 'done' }] }));
        const done = await screen.findByTestId('playbook-done');
        expect(done.textContent).toContain('Facturen bijhouden is ready');
        expect(done.textContent).toContain('not on this plan');
    });

    it('approvals: the same app, a NEW pane key, the approvals brief; a failed turn shows the error code in words', async () => {
        const ready = pb({ version: 12 }, { table: { status: 'done', artifacts: TABLE_ART }, routine: { status: 'done' }, fill: { status: 'done' }, app: { status: 'done', artifacts: { appId: 'app_1', appName: 'Facturen', briefSentAttempt: 0 } }, approvals: { status: 'ready', brief: 'Extend with approvals', artifacts: { appId: 'app_1' } } });
        playbooksApi.get.mockResolvedValue({ playbook: ready });
        playbooksApi.patch.mockResolvedValueOnce({ playbook: pb({ version: 13 }, { table: { status: 'done', artifacts: TABLE_ART }, routine: { status: 'done' }, fill: { status: 'done' }, app: { status: 'done', artifacts: { appId: 'app_1', appName: 'Facturen', briefSentAttempt: 0 } }, approvals: { status: 'running', brief: 'Extend with approvals', artifacts: { appId: 'app_1' } } }) });
        renderRun();
        await screen.findByTestId('builder-pane');
        expect(paneProps.mock.calls[0][0].autoSend).toContain('Extend with approvals');
        expect(screen.getByTestId('playbook-stage-app').getAttribute('data-phase')).toBe('approvals');
        playbooksApi.patch.mockResolvedValue({ playbook: pb({ version: 14 }, { table: { status: 'done', artifacts: TABLE_ART }, routine: { status: 'done' }, fill: { status: 'done' }, app: { status: 'done', artifacts: { appId: 'app_1' } }, approvals: { status: 'failed', error: 'model_empty_reply', artifacts: { appId: 'app_1' } } }) });
        fireEvent.click(screen.getByText('fail-app'));
        await waitFor(() => expect(playbooksApi.patch.mock.calls.some(([, body]) => body.phases?.[0]?.status === 'failed' && body.phases[0].error === 'model_empty_reply')).toBe(true));
        expect(await screen.findByText('The model returned nothing usable — try again.')).toBeTruthy();
    });

    it('Stop asks first, then PATCHes status stopped and shows what landed', async () => {
        playbooksApi.get.mockResolvedValue({ playbook: pb({ version: 6 }, { table: { status: 'done', artifacts: TABLE_ART }, routine: { status: 'running', brief: 'b', artifacts: { automationId: 'auto_1' } } }) });
        playbooksApi.patch.mockResolvedValueOnce({ playbook: pb({ version: 7, status: 'stopped' }, { table: { status: 'done', artifacts: TABLE_ART }, routine: { status: 'running', artifacts: { automationId: 'auto_1', automationTitle: 'Facturen inlezen' } } }) });
        renderRun();
        fireEvent.click(await screen.findByTestId('playbook-bar-stop'));
        expect(playbooksApi.patch).not.toHaveBeenCalled();
        // The dialog's own confirm button (ConfirmDialog carries stable ids
        // now); the bar's Stop is the one with data-testid=playbook-bar-stop.
        fireEvent.click(await screen.findByTestId('confirm-dialog-confirm'));
        await waitFor(() => expect(playbooksApi.patch).toHaveBeenCalledWith('pb_1', { expectedVersion: 6, status: 'stopped' }));
        const done = await screen.findByTestId('playbook-done');
        expect(done.textContent).toContain('Stopped — this is what landed');
        expect(done.textContent).toContain('Facturen inlezen');
        expect(screen.queryByTestId('builder-shell')).toBeNull();
    });

    it('Autopilot lingers on a landing with a countdown (the rows stay visible), then continues once — "Continue now" skips the wait and never doubles', async () => {
        setItem('playbooks.autopilot', '1');
        playbooksApi.get.mockResolvedValue({ playbook: pb({ version: 4 }, { table: { status: 'awaiting', artifacts: TABLE_ART }, routine: { status: 'pending', brief: 'b' } }) });
        playbooksApi.patch.mockResolvedValue({ playbook: pb({ version: 5 }, { table: { status: 'awaiting', artifacts: TABLE_ART }, routine: { status: 'pending', brief: 'b' } }) });
        renderRun();
        // The landing is shown first: a countdown chip, no handoff card, no PATCH yet.
        const chip = await screen.findByTestId('playbook-autopilot-countdown');
        expect(chip.textContent).toContain('Autopilot continues in 6 s');
        expect(screen.queryByTestId('playbook-handoff')).toBeNull();
        expect(playbooksApi.patch).not.toHaveBeenCalled();
        expect(screen.getByTestId('playbook-autopilot').getAttribute('aria-checked')).toBe('true');
        fireEvent.click(screen.getByTestId('playbook-autopilot-now'));
        await waitFor(() => expect(playbooksApi.patch).toHaveBeenCalledWith('pb_1', { expectedVersion: 4, phases: [{ key: 'table', status: 'done' }] }));
        // The (odd) answer still says awaiting at version 5 — a NEW landing, so a new countdown; the old timer never fires a second Continue.
        await screen.findByTestId('playbook-autopilot-countdown');
        await new Promise((r) => setTimeout(r, 1200));
        expect(playbooksApi.patch).toHaveBeenCalledTimes(1);
    });

    it('Autopilot never closes the film itself: on the LAST phase the handoff card stays up (no countdown, nothing stranded)', async () => {
        setItem('playbooks.autopilot', '1');
        // App landed; the only phase after it is locked, so there is no next
        // phase to hand the turn to. Autopilot refuses this one by design —
        // and the card used to hide BECAUSE autopilot was on, leaving a screen
        // with no countdown, no Continue and nothing to press (2026-09-17).
        playbooksApi.get.mockResolvedValue({ playbook: pb({ version: 11 }, { table: { status: 'done', artifacts: TABLE_ART }, routine: { status: 'done', artifacts: { automationId: 'auto_1' } }, fill: { status: 'done', artifacts: { rowCount: 32 } }, app: { status: 'awaiting', artifacts: { appId: 'app_1', appName: 'Facturen' }, summary: 'App "Facturen" built.' }, approvals: { status: 'locked' } }) });
        renderRun();
        await screen.findByTestId('app-shell');
        const card = await screen.findByTestId('playbook-handoff');
        expect(card.getAttribute('data-face')).toBe('awaiting');
        expect(screen.getByTestId('playbook-continue').textContent).toContain('Finish');
        expect(screen.queryByTestId('playbook-autopilot-countdown')).toBeNull();
    });
});
