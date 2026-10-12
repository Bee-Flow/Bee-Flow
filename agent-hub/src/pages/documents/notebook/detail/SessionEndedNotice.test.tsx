import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import SessionEndedNotice from './SessionEndedNotice';
import type { NotebookCollabState } from './useNotebookCollab';
import type { NotebookEditorHandle } from './editorHandle';

/**
 * The live session of a notebook ended before the server confirmed what was
 * typed here (typing while it was folded back, an offline backlog for a
 * notebook that moved, a paste too large to share). Those edits were only in
 * the editor, and "Reopen" replaced it with the saved notebook: they are kept
 * as a version first, and the way out that would lose them is not offered
 * until then. The network is the global fetch, stubbed.
 */

const fetchMock = vi.fn();
beforeEach(() => { fetchMock.mockReset(); vi.stubGlobal('fetch', fetchMock); });
afterEach(() => { vi.unstubAllGlobals(); });

function collab(over: Partial<NotebookCollabState> = {}, unsent = true): NotebookCollabState {
    const handle = { status: 'disabled', canEdit: true, ready: true, unsent, ydoc: {}, fragment: {}, awareness: {}, peers: [], userId: 'erin', retry: vi.fn(), destroy: vi.fn() };
    return { handle: handle as never, bound: true, slow: false, ended: true, saveMode: null, goSolo: vi.fn(), rejoin: vi.fn(), ...over };
}
const editorRef = { current: { getEditor: () => ({ getHTML: () => '<p>typed during the fold-back</p>' }) } } as React.MutableRefObject<NotebookEditorHandle | null>;
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

describe('SessionEndedNotice', () => {
    it('keeps what the ended session never confirmed, and offers to reopen only once it is kept', async () => {
        let answer!: (r: Response) => void;
        fetchMock.mockImplementation(() => new Promise<Response>((resolve) => { answer = resolve; }));
        const onReload = vi.fn();
        render(<SessionEndedNotice notebookId="nb1" collab={collab()} editorRef={editorRef} onReload={onReload} />);

        expect(screen.getByTestId('notebook-notice')).toHaveTextContent(/being kept in the version history/);
        expect(screen.queryByRole('button', { name: 'Reopen' })).not.toBeInTheDocument();
        const [url, init] = fetchMock.mock.calls[0];
        expect(String(url)).toMatch(/\/api\/notebooks\/nb1\/versions\/kept$/);
        expect(init.method).toBe('POST');
        expect(JSON.parse(init.body)).toEqual({ html: '<p>typed during the fold-back</p>' });
        await userEvent.setup().click(screen.getByRole('button', { name: 'Dismiss' }));
        expect(onReload).not.toHaveBeenCalled();

        answer(json(201, { version: { id: 'kept-1' } }));
        expect(await screen.findByText(/They are kept in the version history/)).toBeInTheDocument();
        await userEvent.setup().click(screen.getByRole('button', { name: 'Reopen' }));
        expect(onReload).toHaveBeenCalledTimes(1);
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('when they cannot be kept (the notebook is gone), it says so and closing the notice leaves them on the page', async () => {
        fetchMock.mockResolvedValue(json(404, { error: 'Notebook not found' }));
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const onReload = vi.fn();
        render(<SessionEndedNotice notebookId="nb1" collab={collab({}, true)} editorRef={editorRef} onReload={onReload} />);
        expect(await screen.findByText(/could not be kept\. Copy them from the page/)).toBeInTheDocument();
        await userEvent.setup().click(screen.getByRole('button', { name: 'Dismiss' }));
        expect(onReload).not.toHaveBeenCalled();
        expect(screen.queryByTestId('notebook-notice')).not.toBeInTheDocument();
    });

    it('everything was confirmed: the plain notice, nothing sent', () => {
        render(<SessionEndedNotice notebookId="nb1" collab={collab({}, false)} editorRef={editorRef} onReload={vi.fn()} />);
        expect(screen.getByTestId('notebook-notice')).toHaveTextContent('The live session ended. Reopen the notebook to continue.');
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('a session that has not ended shows nothing', () => {
        const { container } = render(<SessionEndedNotice notebookId="nb1" collab={collab({ ended: false })} editorRef={editorRef} onReload={vi.fn()} />);
        expect(container).toBeEmptyDOMElement();
        expect(fetchMock).not.toHaveBeenCalled();
    });
});
