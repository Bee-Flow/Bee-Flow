/**
 * BFSF-270 — the Upload files modal must work for UNSAVED drafts.
 *
 * The button used to silently no-op for drafts (render gate on agent?.id).
 * Pins: (a) the draft notice renders for drafts and not for saved agents,
 * (b) uploading on a draft lazily creates a KB named after the LIVE typed
 * agent name (not the stale "Untitled" shell) and ingests into it, staging
 * the link via onKnowledgeBaseIdsChange, (c) upload failures surface in the
 * inline error line.
 *
 * BFSF-392 — the dialog and the "Upload files" pill must agree on the count:
 * the dialog reports the total it shows, and draws the knowledge-bases
 * heading once.
 *
 * Run: cd agent-hub && npx vitest run src/components/agents/AgentWizard/pickers/FilesUploadModal.test.jsx
 */
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';

const fetchCalls = [];
let failIngest = false;
// Documents per knowledge base, in the shape GET /api/kb/:id/documents sends.
let docsByKb = {};

vi.mock('../../../../utils/helpers', () => ({
    API_BASE: '',
    authFetch: vi.fn(async (url, opts = {}) => {
        fetchCalls.push({ url, method: opts.method || 'GET', body: opts.body });
        if (url === '/api/kb' && opts.method === 'POST') {
            return { ok: true, json: async () => ({ id: 'kb-new' }) };
        }
        const ingest = /\/api\/kb\/([^/]+)\/ingest\/file$/.exec(url);
        if (ingest) {
            if (failIngest) return { ok: false, text: async () => 'ingest exploded' };
            const kb = (docsByKb[ingest[1]] ||= { documents: [], total: 0 });
            kb.documents = [{ id: `d${kb.total + 1}`, title: 'uploaded.txt' }, ...kb.documents];
            kb.total += 1;
            return { ok: true, json: async () => ({ success: true }) };
        }
        const list = /\/api\/kb\/([^/]+)\/documents/.exec(url);
        if (list) {
            const kb = docsByKb[list[1]] || { documents: [], total: 0 };
            return { ok: true, json: async () => ({ documents: kb.documents, total: kb.total, limit: 200, offset: 0 }) };
        }
        return { ok: true, json: async () => ({}) };
    }),
}));

import FilesUploadModal from './FilesUploadModal';

// Interpolates `{count}` like the real t(), so counted phrases read as shown.
const t = (key, fallback, params) => {
    let value = typeof fallback === 'string' ? fallback : key;
    for (const [k, v] of Object.entries(params || {})) value = value.split(`{${k}}`).join(String(v));
    return value;
};

function renderModal({ agent, agentName, knowledgeBaseIds = [], allKbs = [] }) {
    const onKnowledgeBaseIdsChange = vi.fn();
    const onDocCountChange = vi.fn();
    const onKbsChange = vi.fn();
    const utils = render(
        <FilesUploadModal
            t={t}
            agent={agent}
            agentName={agentName}
            knowledgeBaseIds={knowledgeBaseIds}
            onKnowledgeBaseIdsChange={onKnowledgeBaseIdsChange}
            allKbs={allKbs}
            onToggleKbLink={() => {}}
            onCreateKb={() => {}}
            onDocCountChange={onDocCountChange}
            onKbsChange={onKbsChange}
            onClose={() => {}}
        />
    );
    return { ...utils, onKnowledgeBaseIdsChange, onDocCountChange, onKbsChange };
}

const DRAFT = { id: null, name: 'Untitled agent', config: {} };
const NOTICE = /Files are stored in a knowledge base right away/;

beforeEach(() => {
    fetchCalls.length = 0;
    failIngest = false;
    docsByKb = {};
});

describe('FilesUploadModal — draft support (BFSF-270)', () => {
    it('shows the draft notice for unsaved drafts, hides it for saved agents', () => {
        const { unmount } = renderModal({ agent: DRAFT, agentName: 'Sales Coach' });
        expect(screen.getByText(NOTICE)).toBeTruthy();
        unmount();

        renderModal({ agent: { id: 'a1', name: 'Saved', config: {} }, agentName: 'Saved' });
        expect(screen.queryByText(NOTICE)).toBeNull();
    });

    it('drop on a draft creates a KB named after the LIVE typed name, ingests, stages the link', async () => {
        const { onKnowledgeBaseIdsChange } = renderModal({ agent: DRAFT, agentName: 'Sales Coach' });

        const dropZone = screen.getByTestId('files-drop-zone');
        const file = new File(['hello'], 'notes.txt', { type: 'text/plain' });
        fireEvent.drop(dropZone, { dataTransfer: { files: [file] } });

        await waitFor(() => {
            expect(fetchCalls.some(c => c.url === '/api/kb' && c.method === 'POST')).toBe(true);
            expect(fetchCalls.some(c => /\/ingest\/file$/.test(c.url))).toBe(true);
        });

        const kbCreate = fetchCalls.find(c => c.url === '/api/kb' && c.method === 'POST');
        const body = JSON.parse(kbCreate.body);
        expect(body.name).toBe('Sales Coach');
        expect(body.description).toContain('Sales Coach');
        expect(body.name).not.toBe('Untitled agent');

        expect(onKnowledgeBaseIdsChange).toHaveBeenCalledWith(['kb-new']);
    });

    it('surfaces ingest failures in the inline error line', async () => {
        failIngest = true;
        renderModal({ agent: DRAFT, agentName: 'Sales Coach' });
        const dropZone = screen.getByTestId('files-drop-zone');
        fireEvent.drop(dropZone, { dataTransfer: { files: [new File(['x'], 'bad.txt', { type: 'text/plain' })] } });

        await waitFor(() => {
            expect(screen.getByText(/ingest exploded/)).toBeTruthy();
        });
    });
});

describe('FilesUploadModal — one count, shared with the pill (BFSF-392)', () => {
    const SAVED = { id: 'a1', name: 'Saved', config: {} };
    // The heading reads "Documents (N)"; the stub t() returns the bare key.
    const documentsHeading = (n) => new RegExp(`^agent_wizard\\.files\\.documents \\(${n}\\)$`);
    const twoDocs = () => ({
        documents: [{ id: 'd1', title: 'one.docx' }, { id: 'd2', title: 'two.docx' }],
        total: 2,
    });

    it('reports the total it shows, again after an upload, and asks for a list refresh', async () => {
        docsByKb = { 'kb-a': twoDocs() };
        const user = userEvent.setup();
        const { onDocCountChange, onKbsChange } = renderModal({ agent: SAVED, agentName: 'Saved', knowledgeBaseIds: ['kb-a'] });

        expect(await screen.findByText(documentsHeading(2))).toBeTruthy();
        expect(onDocCountChange).toHaveBeenLastCalledWith('kb-a', 2);

        await user.upload(screen.getByTestId('files-drop-zone'), new File(['x'], 'three.txt', { type: 'text/plain' }));

        expect(await screen.findByText(documentsHeading(3))).toBeTruthy();
        expect(onDocCountChange).toHaveBeenLastCalledWith('kb-a', 3);
        expect(onKbsChange).toHaveBeenCalledTimes(1);
    });

    it('counts every document in the base, not only the page it received', async () => {
        docsByKb = { 'kb-a': { documents: twoDocs().documents, total: 250 } };
        const { onDocCountChange } = renderModal({ agent: SAVED, agentName: 'Saved', knowledgeBaseIds: ['kb-a'] });

        expect(await screen.findByText(documentsHeading(250))).toBeTruthy();
        expect(onDocCountChange).toHaveBeenLastCalledWith('kb-a', 250);
    });

    it('uploads into the base created with the agent, as the pill counts it', async () => {
        docsByKb = { 'kb-primary': twoDocs(), 'kb-other': { documents: [], total: 0 } };
        const agent = { ...SAVED, config: { wizard: { primaryKbId: 'kb-primary' } } };
        const { onDocCountChange } = renderModal({ agent, agentName: 'Saved', knowledgeBaseIds: ['kb-other', 'kb-primary'] });

        expect(await screen.findByText(documentsHeading(2))).toBeTruthy();
        expect(onDocCountChange).toHaveBeenLastCalledWith('kb-primary', 2);
    });

    it('draws the knowledge-bases heading once, with a document count per base', () => {
        renderModal({
            agent: SAVED,
            agentName: 'Saved',
            allKbs: [
                { id: 'kb-a', name: 'Alpha', documentCount: 1, documentCountAll: 2 },
                { id: 'kb-b', name: 'Beta', documentCount: 1, documentCountAll: 1 },
            ],
        });

        expect(screen.getAllByText(/Knowledge bases|agent_wizard\.knowledge\.kbs/)).toHaveLength(1);
        expect(screen.getByText('2 documents')).toBeTruthy();
        expect(screen.getByText('1 document')).toBeTruthy();
    });
});
