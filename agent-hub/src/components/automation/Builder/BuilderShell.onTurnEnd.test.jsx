import { render as rtlRender, act, waitFor, cleanup } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * The hooks a page that DRIVES the builder needs (Studio Playbooks): the end
 * of a turn as the server saw it, a pinned tier that never touches the user's
 * preference, and a back label in the host's words.
 */

vi.mock('../../../utils/helpers', () => ({ API_BASE: '', authFetch: vi.fn() }));
vi.mock('../../shared/Toast', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock('./DiagramPane', () => ({ default: () => null, applyAddNode: (d) => d }));
vi.mock('../../chat/InputArea', () => ({ default: () => null }));
vi.mock('../../admin/Studio/Executions/ExecutionsPanel', () => ({ default: () => null }));
vi.mock('./versions/VersionsTab', () => ({ default: () => null }));
vi.mock('./TriggerDiagnosePanel', () => ({ default: () => null }));

let buildTab = null;
let header = null;
vi.mock('./BuilderHeader', () => ({ default: (p) => { header = p; return null; } }));
vi.mock('./BuildTab', () => ({ default: (p) => { buildTab = p; header = p.headerProps; return null; } }));
vi.mock('./SettingsTab', () => ({ default: () => null }));

import BuilderShell from './BuilderShell.jsx';
import { queryWrapper } from '../../../test/queryWrapper';
import { authFetch } from '../../../utils/helpers';
import scopedStorage, { setCurrentUser } from '../../../utils/scopedStorage';

// The hooks under this tree read through React Query, so every render needs
// a client above it — a fresh one per render, never the app singleton.
const render = (ui, options) => rtlRender(ui, { wrapper: queryWrapper(), ...options });

const json = (body, { ok = true, status = 200 } = {}) => ({ ok, status, json: () => Promise.resolve(body) });
const sse = (event, data) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
function sseResponse(events) {
    const enc = new TextEncoder();
    const stream = new ReadableStream({
        start(controller) { for (const e of events) controller.enqueue(enc.encode(e)); controller.close(); },
    });
    return { ok: true, status: 200, body: stream };
}

let streamBodies;   // the POST /builder/stream bodies, in order
let nextStream;     // events the next stream answers with
let streamHttp;     // non-200 answer for the next stream, when set

function mockFetch() {
    authFetch.mockReset();
    authFetch.mockImplementation((url, opts = {}) => {
        const method = opts.method || 'GET';
        if (url.startsWith('/api/automation/builder/stream') && method === 'POST') {
            streamBodies.push(JSON.parse(opts.body));
            if (streamHttp) { const r = streamHttp; streamHttp = null; return Promise.resolve(json({ error: 'Gateway timeout' }, { ok: false, status: r })); }
            return Promise.resolve(sseResponse(nextStream));
        }
        if (url === '/api/automation/_runs/active') return Promise.resolve(json({ active: [] }));
        if (url.startsWith('/api/automation/builder/session/')) return Promise.resolve(json({}, { ok: false, status: 404 }));
        if (url.startsWith('/ai/config/tiers-for-user')) return Promise.resolve(json({ auto: { label: 'Auto' }, fast: { label: 'Fast' } }));
        if (url === '/api/automation/a9' && method === 'GET') return Promise.resolve(json({ automation: { id: 'a9', title: 'Facturen inlezen', definition: { trigger: { kind: 'manual' }, steps: [], edges: [] } } }));
        return Promise.resolve(json({}));
    });
}

describe('BuilderShell — onTurnEnd / forcedTier / backLabel (the Playbook hooks)', () => {
    beforeEach(() => {
        buildTab = null; header = null; streamBodies = []; nextStream = []; streamHttp = null;
        setCurrentUser('u1');
        scopedStorage.removeItem?.('automationBuilderTier');
        mockFetch();
    });
    afterEach(() => { cleanup(); });

    it('a finalized build ends the turn with finalized:true and the automation id; the pinned tier rides the send and stays out of the preference', async () => {
        const onTurnEnd = vi.fn();
        const resolved = vi.fn();
        nextStream = [
            sse('builder_session', { builderSessionId: 'bs1', automationId: 'a9' }),
            sse('tool_call', { name: 'builder_set_plan', arguments: {}, result: { ok: true } }),
            sse('finalized', { automationId: 'a9' }),
            sse('done', { automationId: 'a9', finalized: true, iterations: 3 }),
        ];
        render(<BuilderShell automationId={null} autoSendInput="Build the invoice automation" forcedTier="fast" backLabel="Back to playbook" onAutomationIdResolved={resolved} onTurnEnd={onTurnEnd} onBack={() => {}} user={{ id: 'u1' }} />);
        await waitFor(() => expect(streamBodies.length).toBe(1));
        expect(streamBodies[0].message).toBe('Build the invoice automation');
        expect(streamBodies[0].modelTier).toBe('fast');
        await waitFor(() => expect(onTurnEnd).toHaveBeenCalledTimes(1));
        expect(onTurnEnd.mock.calls[0][0]).toMatchObject({ finalized: true, aborted: false, error: null, automationId: 'a9' });
        expect(onTurnEnd.mock.calls[0][0].messageCount).toBeGreaterThan(0);
        expect(resolved).toHaveBeenCalledWith('a9');
        // The picker shows the pinned tier and cannot persist a change.
        expect(buildTab.selectedTier).toBe('fast');
        act(() => { buildTab.setSelectedTier('thinking'); });
        expect(scopedStorage.getItem('automationBuilderTier')).not.toBe('thinking');
        // The header says where back goes.
        expect(header.backLabel).toBe('Back to playbook');
    });

    it('a turn that ends without finalize (the model asked a question) reports finalized:false; an abort reports aborted:true', async () => {
        const onTurnEnd = vi.fn();
        nextStream = [
            sse('builder_session', { builderSessionId: 'bs2', automationId: 'a9' }),
            sse('message', { content: 'Which folder?' }),
            sse('done', { automationId: 'a9', finalized: false }),
        ];
        render(<BuilderShell automationId={null} autoSendInput="Build it" onTurnEnd={onTurnEnd} onBack={() => {}} user={{ id: 'u1' }} />);
        await waitFor(() => expect(onTurnEnd).toHaveBeenCalledTimes(1));
        expect(onTurnEnd.mock.calls[0][0]).toMatchObject({ finalized: false, aborted: false, error: null });
        cleanup();

        const onAbort = vi.fn();
        nextStream = [
            sse('builder_session', { builderSessionId: 'bs3', automationId: 'a9' }),
            sse('builder_aborted', { reason: 'repeated_rejection', iterations: 4 }),
            sse('done', { automationId: 'a9', finalized: false }),
        ];
        render(<BuilderShell automationId={null} autoSendInput="Build it" onTurnEnd={onAbort} onBack={() => {}} user={{ id: 'u1' }} />);
        await waitFor(() => expect(onAbort).toHaveBeenCalledTimes(1));
        expect(onAbort.mock.calls[0][0]).toMatchObject({ finalized: false, aborted: true });
    });

    it('an HTTP failure of the stream ends the turn with an error', async () => {
        const onTurnEnd = vi.fn();
        streamHttp = 504;
        render(<BuilderShell automationId={null} autoSendInput="Build it" onTurnEnd={onTurnEnd} onBack={() => {}} user={{ id: 'u1' }} />);
        await waitFor(() => expect(onTurnEnd).toHaveBeenCalledTimes(1));
        expect(onTurnEnd.mock.calls[0][0].finalized).toBe(false);
        expect(typeof onTurnEnd.mock.calls[0][0].error).toBe('string');
    });

    it('without a host: the header keeps "Back to Automations" and the picker persists as before', async () => {
        render(<BuilderShell automationId={null} onBack={() => {}} user={{ id: 'u1' }} />);
        await waitFor(() => expect(buildTab).toBeTruthy());
        expect(header.backLabel).toBeNull();
        act(() => { buildTab.setSelectedTier('fast'); });
        expect(scopedStorage.getItem('automationBuilderTier')).toBe('fast');
    });
});

// A build opened from "Find repeating work" (index.jsx hands the pattern in as
// `patternOrigin`): usePatternOrigin records `built` when it is really done.
describe('BuilderShell — patternOrigin', () => {
    beforeEach(() => {
        buildTab = null; header = null; streamBodies = []; nextStream = []; streamHttp = null;
        setCurrentUser('u1');
        mockFetch();
    });
    afterEach(() => { cleanup(); });

    it('a build opened from a "Find repeating work" pattern records `built` once it is finalized, not before', async () => {
        const feedbackBodies = () => authFetch.mock.calls
            .filter(([url, opts]) => url === '/api/automation/builder/feedback' && opts?.method === 'POST')
            .map(([, opts]) => JSON.parse(opts.body));
        const patternOrigin = { signature: 'sig-1', suggestion: { id: 's1', title: 'Log invoices' } };

        nextStream = [
            sse('builder_session', { builderSessionId: 'bs4', automationId: 'a9' }),
            sse('message', { content: 'Which sheet?' }),
            sse('done', { automationId: 'a9', finalized: false }),
        ];
        const onAsk = vi.fn();
        render(<BuilderShell automationId={null} autoSendInput="Build it" patternOrigin={patternOrigin} onTurnEnd={onAsk} onBack={() => {}} user={{ id: 'u1' }} />);
        await waitFor(() => expect(onAsk).toHaveBeenCalledTimes(1));
        // The draft exists now, but nothing is built yet.
        expect(feedbackBodies()).toEqual([]);
        cleanup();

        nextStream = [
            sse('builder_session', { builderSessionId: 'bs5', automationId: 'a9' }),
            sse('finalized', { automationId: 'a9' }),
            sse('done', { automationId: 'a9', finalized: true }),
        ];
        const onDone = vi.fn();
        render(<BuilderShell automationId={null} autoSendInput="Build it" patternOrigin={patternOrigin} onTurnEnd={onDone} onBack={() => {}} user={{ id: 'u1' }} />);
        await waitFor(() => expect(feedbackBodies()).toHaveLength(1));
        expect(feedbackBodies()[0]).toEqual({ action: 'built', signature: 'sig-1', suggestion: { id: 's1', title: 'Log invoices' } });
    });
});
