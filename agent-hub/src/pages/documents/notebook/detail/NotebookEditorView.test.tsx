import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { forwardRef, useImperativeHandle, useRef } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { testQueryClient, withQueryClient } from '@/test/queryWrapper';
import type { NotebookDetailData } from '../notebookQueries';

// ── Seams: the editor, the live session, the network ────────────────
const h = vi.hoisted(() => ({
    collab: null as null | Record<string, unknown>,
    collabOpts: [] as Array<Record<string, unknown>>,
    editorProps: null as null | Record<string, unknown>,
    setContent: vi.fn(),
    replaceDocument: vi.fn(),
    openShortcuts: vi.fn(),
    editorHtml: '<p>Hello</p>',
    retry: vi.fn(),
    api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), delete: vi.fn() },
    notebookApi: vi.fn(),
    chatProps: null as null | Record<string, unknown>,
    historyProps: null as null | Record<string, unknown>,
    // The chat engine: what was sent, its options, and a way to end the running turn.
    sent: [] as Array<{ text: string; payload: Record<string, unknown> }>,
    engineOpts: null as null | Record<string, any>,
    finishTurn: null as null | ((messages: unknown[]) => void),
}));

vi.mock('@/editor/react/RichTextEditor.jsx', () => ({
    default: forwardRef(function FakeEditor(props: Record<string, unknown>, ref) {
        h.editorProps = props;
        const html = useRef(String(props.content || ''));
        useImperativeHandle(ref, () => ({
            flush: () => null,
            setContent: (v: string) => { html.current = v; h.setContent(v); },
            replaceDocument: (v: string) => { html.current = v; h.replaceDocument(v); },
            openShortcuts: h.openShortcuts,
            getEditor: () => ({ getHTML: () => h.editorHtml, getText: () => h.editorHtml.replace(/<[^>]+>/g, '') }),
            insertContent: vi.fn(),
            highlightAnchors: vi.fn(),
            scrollToHeading: vi.fn(),
        }));
        const type = () => {
            h.editorHtml = '<p>Typed by me</p>';
            (props.onChange as (html: string) => void)?.(h.editorHtml);
            (props.onSave as (html: string) => void)?.(h.editorHtml);
        };
        return (
            <div data-testid="editor" data-editable={String(props.editable)} data-collab={props.collab ? 'on' : 'off'}>
                <button type="button" onClick={type}>type something</button>
            </div>
        );
    }),
}));
vi.mock('@/editor/collab/useCollab', () => ({
    default: (opts: Record<string, unknown>) => { h.collabOpts.push(opts); return opts.enabled ? h.collab : null; },
}));
vi.mock('@/editor/react/CollabPresence', () => ({ default: () => <span data-testid="presence" /> }));
vi.mock('@/components/versions/VersionHistoryPanel', () => ({
    default: (props: Record<string, unknown>) => { h.historyProps = props; return <aside data-testid="history" data-can-edit={String(props.canEdit)} />; },
}));
vi.mock('@/components/versions/VersionCompare', () => ({ default: () => <div data-testid="compare" /> }));
vi.mock('@/components/comments/CommentsPanel', () => ({ default: () => <aside data-testid="comments" /> }));
vi.mock('@/hooks/useChatEngine', async () => {
    const { useCallback, useState } = await import('react');
    return {
        // A turn starts loading when sent and ends when the test calls h.finishTurn.
        default: (opts: Record<string, any>) => {
            h.engineOpts = opts;
            const [isLoading, setIsLoading] = useState(false);
            const [messages, setMessages] = useState<unknown[]>([]);
            h.finishTurn = (next) => { setMessages(next); setIsLoading(false); };
            const sendMessage = useCallback(async (text: string) => {
                h.sent.push({ text, payload: opts.directMode.getExtraPayload() });
                setIsLoading(true);
            }, [opts.directMode]);
            return { messages, setMessages, isLoading, sendMessage, stopGenerating: vi.fn(), retryMessage: vi.fn(), editAndRegenerate: vi.fn() };
        },
    };
});
vi.mock('../NotebookChat', () => ({
    default: (props: Record<string, unknown>) => { h.chatProps = props; return <div data-testid="chat">{props.privateHint ? 'Only you see this chat.' : null}</div>; },
}));
vi.mock('../hooks/useModelTiers', () => ({ default: () => ({ modelTiers: {}, selectedTier: 'fast', setSelectedTier: vi.fn() }) }));
vi.mock('../hooks/useExportTargets', () => ({ default: () => ({ signRequestConfigured: false, nextcloudConfigured: false }) }));
vi.mock('@/api/notebookApi', async (orig) => ({ ...(await orig<Record<string, unknown>>()), notebookApi: h.notebookApi }));
vi.mock('@/api/client', async (orig) => ({ ...(await orig<Record<string, unknown>>()), apiClient: h.api, default: h.api }));
vi.mock('@/components/meeting-picker/MeetingPicker', () => ({ default: () => null }));
vi.mock('@/pages/meeting-notes/capture/CaptureContext', () => ({ useCapture: () => ({ openCapture: () => {} }) }));

import NotebookEditorView from './NotebookEditorView';

const PROJECT = { id: 'p1', name: 'Launch', kind: 'workspace' as const, color: null, icon: null, role: 'editor' as const };

function detail(over: Partial<NotebookDetailData['notebook']> = {}, extra: Partial<NotebookDetailData> = {}): NotebookDetailData {
    return {
        notebook: {
            id: 'nb1', userId: 'alice', name: 'Research', documentContent: '<p>Hello</p>', documentMd: 'Hello',
            version: 3, projectId: 'p1', role: 'editor', createdAt: '2026-09-01T00:00:00Z', ...over,
        },
        sources: [{ id: 's1', name: 'Report.pdf', type: 'pdf', status: 'ready', hasContent: true, metadata: {} }],
        project: PROJECT,
        collab: { eligible: true },
        ...extra,
    };
}

function renderView(data: NotebookDetailData) {
    return render(withQueryClient(
        <NotebookEditorView data={data} user={{ id: 'erin', name: 'Erin' }} onBack={vi.fn()} onListChanged={vi.fn()} onOpenProject={vi.fn()} onReload={vi.fn()} />,
    ));
}
const puts = () => h.notebookApi.mock.calls.filter(([, o]) => (o as { method?: string } | undefined)?.method === 'PUT');
/** What the page kept as versions of text it could not save. */
const keptBodies = () => h.notebookApi.mock.calls
    .filter(([p, o]) => p === '/nb1/versions/kept' && (o as { method?: string } | undefined)?.method === 'POST')
    .map(([, o]) => JSON.parse((o as { body: string }).body));

/** Render, and render again later with whatever the seams hold by then (a new session, …). */
function renderAgainLater(data: NotebookDetailData) {
    const client = testQueryClient();
    const me = { id: 'erin', name: 'Erin' };
    const ui = () => withQueryClient(
        <NotebookEditorView data={data} user={me} onBack={vi.fn()} onListChanged={vi.fn()} onOpenProject={vi.fn()} onReload={vi.fn()} />, client,
    );
    const view = render(ui());
    return { ...view, again: () => view.rerender(ui()) };
}
const httpError = (status: number, body: unknown) => Object.assign(new Error(`HTTP ${status}`), { status, body });

beforeEach(() => {
    h.collab = null;
    h.collabOpts = [];
    h.editorProps = null;
    h.chatProps = null;
    h.historyProps = null;
    h.sent = [];
    h.engineOpts = null;
    h.finishTurn = null;
    h.editorHtml = '<p>Hello</p>';
    h.setContent.mockReset();
    h.replaceDocument.mockReset();
    h.openShortcuts.mockReset();
    h.retry.mockReset();
    for (const m of Object.values(h.api)) m.mockReset();
    h.api.get.mockImplementation(async (path: string) => (path.endsWith('/conversation') ? { messages: [], locked: false } : {}));
    h.api.post.mockResolvedValue({});
    h.notebookApi.mockReset();
    h.notebookApi.mockResolvedValue({ sources: [] });
});
afterEach(cleanup);

describe('a viewer', () => {
    it('reads a read-only editor with a "View only" pill and is offered nothing that changes the notebook', async () => {
        const user = userEvent.setup();
        renderView(detail({ role: 'viewer', projectRole: 'viewer' }, { project: { ...PROJECT, role: 'viewer' } }));
        expect(screen.getByTestId('editor').dataset.editable).toBe('false');
        expect(screen.getByTestId('notebook-view-only')).toHaveTextContent('View only');
        expect(screen.getByTestId('studio-section-title').tagName).toBe('H1');
        expect(screen.getByRole('button', { name: 'Documents' })).toBeInTheDocument();
        expect(screen.queryByTestId('notebook-starters')).not.toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Remove source' })).not.toBeInTheDocument();
        expect(h.editorProps?.onAIFill).toBeUndefined();
        expect(h.chatProps?.onInsertToDocument).toBeNull();

        await user.click(screen.getByRole('button', { name: 'Version history' }));
        expect(screen.getByTestId('history').dataset.canEdit).toBe('false');
        // Typing cannot save anything for a viewer, even if a keystroke got through.
        await user.click(screen.getByRole('button', { name: 'type something' }));
        expect(puts()).toHaveLength(0);
    });
});

describe('a project notebook edited together', () => {
    it('binds the editor to the live session and never sends a save of its own', async () => {
        const user = userEvent.setup();
        h.collab = { status: 'synced', ready: true, canEdit: true, peers: [], userId: 'erin' };
        renderView(detail());
        expect(h.collabOpts.at(-1)).toMatchObject({ projectId: 'p1', kind: 'notebook', resourceId: 'nb1', enabled: true });
        expect(screen.getByTestId('editor').dataset.collab).toBe('on');
        expect(screen.getByTestId('presence')).toBeInTheDocument();
        expect(screen.getByTestId('save-status-live')).toHaveTextContent('Saved as you type');
        await user.click(screen.getByRole('button', { name: 'type something' }));
        expect(puts()).toHaveLength(0);
        expect(screen.getByTestId('notebook-project-chip')).toHaveTextContent('In Launch');
        expect(screen.getByTestId('chat')).toHaveTextContent('Only you see this chat.');
    });

    it('a notebook outside a project is not co-edited and has no project chip', () => {
        renderView(detail({ projectId: null }, { project: null, collab: { eligible: false } }));
        expect(h.collabOpts.every((o) => o.enabled === false)).toBe(true);
        expect(screen.getByTestId('editor').dataset.collab).toBe('off');
        expect(screen.queryByTestId('notebook-project-chip')).not.toBeInTheDocument();
        expect(screen.getByTestId('chat')).not.toHaveTextContent('Only you see this chat.');
    });
});

describe('a save that lost a race', () => {
    it('keeps my text on screen, shows the choice, and "Use the saved version" loads it', async () => {
        const user = userEvent.setup();
        h.notebookApi.mockImplementation(async (_path: string, opts?: { method?: string }) => {
            if (opts?.method === 'PUT') throw httpError(409, { code: 'version_conflict', details: { conflictVersionId: 'v9', currentVersion: 5 } });
            return { sources: [] };
        });
        h.api.get.mockImplementation(async (path: string) => {
            if (path.endsWith('/conversation')) return { messages: [], locked: false };
            if (path.endsWith('/versions/current')) return { version: { documentVersion: 5, content: { html: '<p>Their text</p>' } } };
            return {};
        });
        renderView(detail({ projectId: null }, { project: null, collab: { eligible: false } }));
        await user.click(screen.getByRole('button', { name: 'type something' }));
        expect(await screen.findByTestId('notebook-conflict')).toBeInTheDocument();
        expect(JSON.parse(String(puts()[0][1] && (puts()[0][1] as { body: string }).body))).toEqual({ documentContent: '<p>Typed by me</p>', expectedVersion: 3 });
        expect(h.setContent).not.toHaveBeenCalled();
        expect(h.replaceDocument).not.toHaveBeenCalled();
        expect(screen.getByTestId('save-status-conflict')).toBeInTheDocument();

        await user.click(screen.getByTestId('notebook-conflict-toggle'));
        expect(screen.getByTestId('compare')).toBeInTheDocument();
        await user.click(screen.getByTestId('notebook-conflict-use-theirs'));
        // The saved version is shown as one undoable step (replaceDocument), not
        // with setContent's fresh history: Ctrl+Z still brings my text back.
        await waitFor(() => expect(h.replaceDocument).toHaveBeenCalledWith('<p>Their text</p>'));
        expect(h.setContent).not.toHaveBeenCalled();
        expect(screen.queryByTestId('notebook-conflict')).not.toBeInTheDocument();
    });

    it('"Use the saved version" first keeps what I typed after the conflict appeared', async () => {
        const user = userEvent.setup();
        h.notebookApi.mockImplementation(async (_path: string, opts?: { method?: string }) => {
            if (opts?.method === 'PUT') throw httpError(409, { code: 'version_conflict', details: { conflictVersionId: 'v9', currentVersion: 5 } });
            return opts?.method === 'POST' ? { version: { id: 'v10', source: 'conflict' } } : { sources: [] };
        });
        h.api.get.mockImplementation(async (path: string) => {
            if (path.endsWith('/conversation')) return { messages: [], locked: false };
            if (path.endsWith('/versions/current')) return { version: { documentVersion: 5, content: { html: '<p>Their text</p>' } } };
            return {};
        });
        renderView(detail({ projectId: null }, { project: null, collab: { eligible: false } }));
        await user.click(screen.getByRole('button', { name: 'type something' }));
        await screen.findByTestId('notebook-conflict');
        // The server kept "<p>Typed by me</p>"; I keep writing while the choice is open.
        h.editorHtml = '<p>Typed by me, and a whole new paragraph</p>';

        await user.click(screen.getByTestId('notebook-conflict-use-theirs'));
        await waitFor(() => expect(h.replaceDocument).toHaveBeenCalledWith('<p>Their text</p>'));
        expect(keptBodies()).toEqual([{ html: '<p>Typed by me, and a whole new paragraph</p>' }]);
        const keptAt = h.notebookApi.mock.calls.findIndex(([p]) => p === '/nb1/versions/kept');
        expect(h.notebookApi.mock.invocationCallOrder[keptAt]).toBeLessThan(h.replaceDocument.mock.invocationCallOrder[0]);
        expect(await screen.findByTestId('notebook-notice')).toHaveTextContent('What you typed after the conflict is kept in the version history too.');
    });

    it('"Keep my version" saves my text over the version I compared against', async () => {
        const user = userEvent.setup();
        let first = true;
        h.notebookApi.mockImplementation(async (_path: string, opts?: { method?: string }) => {
            if (opts?.method !== 'PUT') return { sources: [] };
            if (first) { first = false; throw httpError(409, { code: 'version_conflict', details: { conflictVersionId: 'v9', currentVersion: 5 } }); }
            return { success: true, version: 6 };
        });
        renderView(detail({ projectId: null }, { project: null, collab: { eligible: false } }));
        await user.click(screen.getByRole('button', { name: 'type something' }));
        await user.click(await screen.findByTestId('notebook-conflict-keep-mine'));
        await waitFor(() => expect(puts()).toHaveLength(2));
        expect(JSON.parse((puts()[1][1] as { body: string }).body)).toEqual({ documentContent: '<p>Typed by me</p>', expectedVersion: 5 });
        await waitFor(() => expect(screen.queryByTestId('notebook-conflict')).not.toBeInTheDocument());
    });
});

describe('a save refused because the notebook is edited together', () => {
    const session = (over: Record<string, unknown>) => ({ canEdit: true, peers: [], userId: 'erin', retry: h.retry, ydoc: {}, ...over });

    it('joins a fresh session, says so only once joined, and holds saving while the join failed', async () => {
        const user = userEvent.setup();
        // The first join failed before its first sync: the page fell back to its own saves.
        h.collab = session({ status: 'error', ready: false });
        h.notebookApi.mockImplementation(async (_path: string, opts?: { method?: string }) => {
            if (opts?.method === 'PUT') throw httpError(409, { code: 'COLLAB_ACTIVE', details: { conflictVersionId: 'v7' } });
            return { sources: [] };
        });
        const view = renderAgainLater(detail());
        await user.click(screen.getByRole('button', { name: 'type something' }));
        await waitFor(() => expect(h.retry).toHaveBeenCalledTimes(1));
        expect(screen.getByTestId('notebook-notice')).toHaveTextContent('Joining the live session');
        expect(screen.getByTestId('notebook-notice')).not.toHaveTextContent('you joined');

        // The fresh session fails too: the page says so, and typing piles up no refused saves.
        h.collab = session({ status: 'error', ready: false });
        view.again();
        expect(await screen.findByRole('alert')).toHaveTextContent('The live session could not be joined');
        await user.click(screen.getByRole('button', { name: 'type something' }));
        await user.click(screen.getByRole('button', { name: 'type something' }));
        expect(puts()).toHaveLength(1);

        // Try again: this time it joins.
        await user.click(screen.getByRole('button', { name: 'Try again' }));
        expect(h.retry).toHaveBeenCalledTimes(2);
        h.collab = session({ status: 'synced', ready: true });
        view.again();
        await waitFor(() => expect(screen.getByTestId('notebook-notice')).toHaveTextContent('you joined the live session. The text you had not saved yet is kept in the version history.'));
        expect(keptBodies()).toEqual([{ html: '<p>Typed by me</p>' }]);
        expect(puts()).toHaveLength(1);
    });

    it('for a person who cannot join (the owner outside the project) later typing is still sent, never held for good', async () => {
        const user = userEvent.setup();
        h.notebookApi.mockImplementation(async (_path: string, opts?: { method?: string }) => {
            if (opts?.method === 'PUT') throw httpError(409, { code: 'COLLAB_ACTIVE', details: { conflictVersionId: 'v7' } });
            return { sources: [] };
        });
        // Filed in p1, but this reader has no role there: no project, not eligible.
        renderView(detail({ role: 'owner' }, { project: null, collab: { eligible: false } }));
        await user.click(screen.getByRole('button', { name: 'type something' }));
        expect(await screen.findByTestId('notebook-notice')).toHaveTextContent('being edited together in its project right now');
        expect(h.retry).not.toHaveBeenCalled();

        // It used to wait for a join that never came: nothing more was sent and a reload lost it.
        await user.click(screen.getByRole('button', { name: 'type something' }));
        await waitFor(() => expect(puts()).toHaveLength(2));
        expect(screen.queryByTestId('save-status-dirty')).not.toBeInTheDocument();
    });
});

describe('the command palette', () => {
    it('"Keyboard shortcuts" opens the editor\'s shortcuts sheet', async () => {
        const user = userEvent.setup();
        renderView(detail());
        await user.click(screen.getByRole('button', { name: 'Command palette (⌘K)' }));
        await user.click(await screen.findByRole('option', { name: /Keyboard shortcuts/ }));
        expect(h.openShortcuts).toHaveBeenCalledTimes(1);
    });
});

describe('an empty notebook', () => {
    it('offers starters to an editor', async () => {
        await act(async () => { renderView(detail({ documentContent: '<p></p>' })); });
        expect(screen.getByTestId('notebook-starters')).toBeInTheDocument();
        expect(screen.getByTestId('starter-summary')).toBeEnabled();
    });
});

type AIAction = (key: string, text: string, range: { from: number; to: number }, customQuery: string | null) => void;
/** Run an editor AI action the way the bubble menu does. */
const runAIAction = (key: string, text: string, query: string | null = null) => act(() => {
    (h.editorProps?.onAIAction as AIAction)(key, text, { from: 1, to: 1 + text.length }, query);
});
const endTurn = (answer: string) => act(() => {
    h.finishTurn?.([{ id: 'u1', role: 'user', content: 'the prompt' }, { id: 'a1', role: 'assistant', content: answer }]);
});

function renderPanel(data: NotebookDetailData, over: { onOpenInStudio?: () => void; onBack?: () => void } = {}) {
    return render(withQueryClient(
        <NotebookEditorView data={data} user={{ id: 'erin', name: 'Erin' }} variant="panel" onOpenInStudio={over.onOpenInStudio ?? vi.fn()}
            onBack={over.onBack ?? vi.fn()} onListChanged={vi.fn()} onOpenProject={vi.fn()} onReload={vi.fn()} />,
    ));
}

describe('beside the main chat (panel)', () => {
    it('is the editor alone: no sources, no notebook chat; Close and Open in Studio', async () => {
        const user = userEvent.setup();
        const onBack = vi.fn();
        const onOpenInStudio = vi.fn();
        renderPanel(detail(), { onBack, onOpenInStudio });
        expect(screen.getByTestId('editor').dataset.editable).toBe('true');
        expect(screen.queryByTestId('chat')).not.toBeInTheDocument();
        expect(screen.queryByText('Report.pdf')).not.toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Toggle AI Chat' })).not.toBeInTheDocument();

        await user.click(screen.getByRole('button', { name: 'Open in Studio' }));
        expect(onOpenInStudio).toHaveBeenCalled();
        await user.click(screen.getByRole('button', { name: 'Close' }));
        expect(onBack).toHaveBeenCalled();
    });

    it('Rewrite asks the notebook AI to change the selection in place and veils the editor until the run ends', async () => {
        renderPanel(detail());
        expect(h.editorProps?.askAiEnabled).toBe(true);
        expect(h.editorProps?.generatingLabel).toBeUndefined();

        await runAIAction('rewrite', 'Old text');
        expect(h.sent).toHaveLength(1);
        expect(h.sent[0].text).toBe('Rewrite the selected text. Use notebook_doc_replace to apply the change in place.');
        expect(h.sent[0].payload.notebookSelection).toEqual({ text: 'Old text', from: 1, to: 9, action: 'rewrite' });
        expect(h.editorProps?.generatingLabel).toBe('Rewriting…');

        // The change arrives as a document update; the answer stays in the chat history.
        await act(() => { h.engineOpts?.onNotebookDocUpdate('<p>New text</p>', null, 4); });
        await endTurn('Done: rewrote the selection.');
        expect(h.editorProps?.generatingLabel).toBeUndefined();
        expect(screen.queryByTestId('notebook-notice')).not.toBeInTheDocument();
    });

    it('Ask AI sends the question as an in-place change; an answer that changed nothing is shown in the notice', async () => {
        renderPanel(detail());

        await runAIAction('ask', 'The quarterly figures', 'Who wrote this?');
        expect(h.sent[0].text).toBe(
            '**Selected text:**\n> The quarterly figures\n\nChange the selected text as asked: Who wrote this?. '
            + 'Use notebook_doc_replace to apply the change in place. If the question cannot be answered by changing the text, answer briefly instead.',
        );
        expect(h.sent[0].payload.notebookSelection).toMatchObject({ action: 'ask' });
        expect(h.editorProps?.generatingLabel).toBe('Working on your question…');

        await endTurn('The finance team wrote it.');
        expect(h.editorProps?.generatingLabel).toBeUndefined();
        const notice = screen.getByTestId('notebook-notice');
        expect(notice).toHaveAttribute('role', 'status');
        expect(notice).toHaveTextContent('The finance team wrote it.');
        // A short answer is complete: no hint to read the rest in Studio.
        expect(screen.queryByRole('button', { name: 'Read it all in Studio' })).not.toBeInTheDocument();
    });

    it('a long answer is cut short in the notice, with a way to read it all in Studio', async () => {
        const user = userEvent.setup();
        const onOpenInStudio = vi.fn();
        renderPanel(detail(), { onOpenInStudio });
        await runAIAction('ask', 'The quarterly figures', 'Explain this');
        await endTurn('word '.repeat(200));
        const notice = screen.getByTestId('notebook-notice');
        expect(notice.textContent!.length).toBeLessThan(600);
        expect(notice).toHaveTextContent('…');
        await user.click(screen.getByRole('button', { name: 'Read it all in Studio' }));
        expect(onOpenInStudio).toHaveBeenCalled();
    });

    it('a run that failed says so in the notice and lifts the veil', async () => {
        renderPanel(detail());
        await runAIAction('shorten', 'Some long text');
        expect(h.editorProps?.generatingLabel).toBe('Shortening…');
        await act(() => { h.finishTurn?.([{ id: 'a1', role: 'assistant', content: 'The model is not available.', isError: true }]); });
        expect(h.editorProps?.generatingLabel).toBeUndefined();
        expect(screen.getByRole('alert')).toHaveTextContent('The model is not available.');
    });

    it('a viewer gets no AI actions at all', () => {
        renderPanel(detail({ role: 'viewer', projectRole: 'viewer' }, { project: { ...PROJECT, role: 'viewer' } }));
        expect(h.editorProps?.onAIAction).toBeUndefined();
        expect(h.editorProps?.askAiEnabled).toBe(false);
    });
});

describe('the AI actions in Studio', () => {
    it('answer in the notebook chat as before: the question goes as asked, no veil, no notice', async () => {
        renderView(detail());
        expect(h.editorProps?.askAiEnabled).toBe(true);
        await runAIAction('ask', 'The quarterly figures', 'Who wrote this?');
        expect(h.sent[0].text).toBe('**Selected text:**\n> The quarterly figures\n\nWho wrote this?');
        expect(h.editorProps?.generatingLabel).toBeUndefined();
        await endTurn('The finance team wrote it.');
        expect(screen.queryByTestId('notebook-notice')).not.toBeInTheDocument();
    });
});
