import { render as rtlRender, act, waitFor, cleanup } from '@testing-library/react';
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * Apply of an assistant proposal. The card hands over the fields the user
 * unticked; the shell asks the server to record the Apply, and when the
 * proposal creates tables the server answers with the definition that points
 * at the real table ids. That definition, with the unticked fields reverted,
 * is what lands on the canvas.
 */

vi.mock('../../../utils/helpers', () => ({ API_BASE: '', authFetch: vi.fn() }));
vi.mock('../../shared/Toast', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock('./DiagramPane', () => ({ default: () => null, applyAddNode: (d: unknown) => d }));
vi.mock('../../chat/InputArea', () => ({ default: () => null }));
vi.mock('../../admin/Studio/Executions/ExecutionsPanel', () => ({ default: () => null }));
vi.mock('./versions/VersionsTab', () => ({ default: () => null }));
vi.mock('./TriggerDiagnosePanel', () => ({ default: () => null }));

// What the stubbed BuildTab was last given: the seam this suite measures the shell through.
let buildTab: any = null;
vi.mock('./BuilderHeader', () => ({ default: () => null }));
vi.mock('./BuildTab', () => ({ default: (p: unknown) => { buildTab = p; return null; } }));
vi.mock('./SettingsTab', () => ({ default: () => null }));

import BuilderShellJsx from './BuilderShell.jsx';
import { queryWrapper } from '../../../test/queryWrapper';
import { authFetch } from '../../../utils/helpers';
import { toast } from '../../shared/Toast';
import { setCurrentUser } from '../../../utils/scopedStorage';

const BuilderShell = BuilderShellJsx as unknown as React.ComponentType<Record<string, unknown>>;
const render = (ui: React.ReactElement) => rtlRender(ui, { wrapper: queryWrapper() });
const json = (body: unknown, { ok = true, status = 200 } = {}) => ({ ok, status, json: () => Promise.resolve(body) });
const sse = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
function sseResponse(events: string[]) {
    const enc = new TextEncoder();
    return { ok: true, status: 200, body: new ReadableStream({ start(c) { for (const e of events) c.enqueue(enc.encode(e)); c.close(); } }) };
}

const base = { trigger: { id: 't', kind: 'manual' }, steps: [], edges: [] };
const staged = {
    ...base,
    steps: [{ id: 'save', type: 'datatable', op: 'add_row', label: 'Save', datatableId: 'pending:1', datatableKey: 'facturen', values: { bedrag: { kind: 'literal', value: 1 } } }],
};
const rebound = { ...staged, steps: [{ ...staged.steps[0], datatableId: 'dt_9', datatableKey: 'facturen' }] };

let reviewAnswer: () => unknown;
let reviewCalls: unknown[];
function mockFetch(proposal: Record<string, unknown>) {
    vi.mocked(authFetch).mockReset();
    vi.mocked(authFetch).mockImplementation(((url: string, opts: RequestInit = {}) => {
        const method = opts.method || 'GET';
        if (url.startsWith('/api/automation/builder/stream') && method === 'POST') {
            return Promise.resolve(sseResponse([
                sse('builder_session', { builderSessionId: 'bs1', automationId: 'a9' }),
                sse('proposal_preview', proposal),
                sse('done', { automationId: 'a9', finalized: false }),
            ]));
        }
        if (url.endsWith('/review') && method === 'POST') { reviewCalls.push(JSON.parse(String(opts.body))); return Promise.resolve(reviewAnswer()); }
        if (url === '/api/automation/_runs/active') return Promise.resolve(json({ active: [] }));
        if (url.startsWith('/api/automation/builder/session/')) return Promise.resolve(json({}, { ok: false, status: 404 }));
        if (url.startsWith('/ai/config/tiers-for-user')) return Promise.resolve(json({ auto: { label: 'Auto' } }));
        if (url === '/api/automation/a9' && method === 'GET') return Promise.resolve(json({ automation: { id: 'a9', title: 'Facturen', definition: base } }));
        return Promise.resolve(json({}));
    }) as never);
}

async function renderWithProposal(proposal: Record<string, unknown>) {
    mockFetch(proposal);
    render(<BuilderShell automationId="a9" onBack={() => {}} user={{ id: 'u1' }} />);
    await waitFor(() => expect(buildTab?.rootDef?.trigger?.id).toBe('t'));
    await act(async () => { buildTab.onSend('Save invoices in a new table', []); });
    await waitFor(() => expect(buildTab?.state?.proposal?.id).toBe(proposal.id));
}

describe('BuilderShell — Apply of a proposal', () => {
    beforeEach(() => {
        buildTab = null; reviewCalls = [];
        setCurrentUser('u1');
        vi.mocked(toast.success).mockClear(); vi.mocked(toast.error).mockClear();
    });
    afterEach(() => { cleanup(); });

    it('commits the server\'s rebound definition, toasts the created table and refetches the catalog', async () => {
        await renderWithProposal({ id: 'p1', baseDefinition: base, definition: staged, pendingDatatables: [{ ref: 'pending:1', name: 'Facturen', key: 'facturen', fields: [] }] });
        reviewAnswer = () => json({ ok: true, outcome: 'applied', definition: rebound, createdDatatables: [{ ref: 'pending:1', id: 'dt_9', key: 'facturen', name: 'Facturen' }] });
        const nonce = buildTab.catalogNonce;
        await act(async () => { await buildTab.onApplyProposal(new Set()); });
        expect(reviewCalls).toEqual([{ action: 'applyProposal', revisionId: 'p1' }]);
        await waitFor(() => expect(buildTab.rootDef.steps[0].datatableId).toBe('dt_9'));
        expect(buildTab.catalogNonce).toBe(nonce + 1);
        expect(String(vi.mocked(toast.success).mock.calls.at(-1)?.[0])).toMatch(/Facturen/);
    });

    it('a refused Apply shows the server\'s message and changes nothing', async () => {
        await renderWithProposal({ id: 'p2', baseDefinition: base, definition: staged, pendingDatatables: [{ ref: 'pending:1', name: 'Facturen', key: 'facturen', fields: [] }] });
        reviewAnswer = () => json({ error: 'manage_datatables_required', message: 'You may not create organisation tables.' }, { ok: false, status: 403 });
        await act(async () => { await buildTab.onApplyProposal(new Set()); });
        expect(vi.mocked(toast.error)).toHaveBeenCalledWith('You may not create organisation tables.');
        expect(buildTab.state.proposal?.id).toBe('p2');
        expect(buildTab.rootDef.steps).toEqual([]);
    });

    it('a proposal without tables keeps its own definition, with unticked fields reverted', async () => {
        const before = { ...base, steps: [{ id: 'mail', type: 'set', label: 'Mail', settings: { to: 'a', subject: 'Old' } }] };
        const after = { ...before, steps: [{ ...before.steps[0], settings: { to: 'b', subject: 'New' } }] };
        await renderWithProposal({ id: 'p3', baseDefinition: base, definition: after });
        reviewAnswer = () => json({ ok: true, outcome: 'applied', definition: null, createdDatatables: [] });
        await act(async () => { await buildTab.onApplyProposal(new Set()); });
        await waitFor(() => expect(buildTab.rootDef.steps[0].settings).toEqual({ to: 'b', subject: 'New' }));
    });

    it('never commits a definition that still points at a staged table', async () => {
        await renderWithProposal({ id: 'p4', baseDefinition: base, definition: staged, pendingDatatables: [{ ref: 'pending:1', name: 'Facturen', key: 'facturen', fields: [] }] });
        reviewAnswer = () => json({ ok: true, outcome: 'applied', definition: null, createdDatatables: [] });
        await act(async () => { await buildTab.onApplyProposal(new Set()); });
        expect(vi.mocked(toast.error)).toHaveBeenCalled();
        expect(buildTab.rootDef.steps).toEqual([]);
    });
});
