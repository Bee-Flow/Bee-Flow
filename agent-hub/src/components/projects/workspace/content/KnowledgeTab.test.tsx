import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { withQueryClient } from '../../../../test/queryWrapper';
import { EDITOR_ID, getRouter, MEMBERS, OWNER_ID, tabProps, type RouteAnswer } from './contentTestKit';
import type { ContentTabProps } from './types';
import { useUndoCapture } from '../undoTestKit';

// Fresh spies per test (assigned in beforeEach) rather than reset ones.
const { client, helpers } = vi.hoisted(() => ({
    client: {} as Record<'get' | 'post' | 'put' | 'patch' | 'delete', ReturnType<typeof vi.fn>>,
    helpers: { authFetch: (() => {}) as unknown as Mock<(...args: unknown[]) => Promise<Response>> },
}));
vi.mock('../../../../api/client', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../../../../api/client')>()),
    apiClient: client,
    default: client,
}));
vi.mock('../../../../utils/helpers', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../../../../utils/helpers')>()),
    authFetch: (...args: unknown[]) => helpers.authFetch(...args),
}));
vi.mock('../../../knowledge/memory/MemoryPanel', () => ({
    default: ({ projectId, canEdit }: { projectId: string; canEdit: boolean }) => (
        <div data-testid="memory-panel" data-project={projectId} data-can-edit={String(canEdit)} />
    ),
}));

import KnowledgeTab from './KnowledgeTab';

const FILES = {
    kbId: 'kb-files',
    files: [
        { id: 'f1', name: 'brief.pdf', size: 204800, status: 'ready', redacted: true, uploadedBy: OWNER_ID, createdAt: '2026-09-20T10:00:00Z' },
        { id: 'f2', name: 'notes.docx', size: 1024, status: 'processing', uploadedBy: EDITOR_ID, createdAt: '2026-09-21T10:00:00Z' },
        { id: 'f3', name: 'scan.png', mimeType: null, size: 5000, status: 'failed', statusReason: 'The same file is already in this project.', uploadedBy: EDITOR_ID, createdAt: '2026-09-21T10:00:00Z' },
    ],
};
const LINKED = [
    { id: 'kb-files', name: 'Launch plan · Files' },
    { id: 'kb-1', name: 'Handbook', description: 'HR policies' },
];
const READABLE = [
    { id: 'kb-1', name: 'Handbook', organization_id: 'org-1' },
    { id: 'kb-2', name: 'Sales playbook', organization_id: 'org-1' },
    { id: 'kb-x', name: 'Partner base', organization_id: 'org-2' },
    { id: 'kb-y', name: 'Another project files', organization_id: 'org-1', source_kind: 'project_files' },
];

function routes(overrides: Record<string, RouteAnswer> = {}) {
    return getRouter({
        '/api/projects/p1/resources': { role: 'editor', knowledgeBases: LINKED },
        '/api/projects/p1/members': MEMBERS,
        '/api/projects/p1/files': FILES,
        '/api/kb': READABLE,
        ...overrides,
    });
}

function renderTab(role: ContentTabProps['role'], extra: Partial<ContentTabProps> = {}) {
    const handlers = { onOpenSub: vi.fn(), onNavigate: vi.fn() };
    render(withQueryClient(<KnowledgeTab {...tabProps(role, handlers, extra)} />));
    return handlers;
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

beforeEach(() => {
    for (const m of ['get', 'post', 'put', 'patch', 'delete'] as const) client[m] = vi.fn();
    client.get.mockImplementation(routes());
    client.put.mockImplementation(async () => ({ success: true }));
    client.delete.mockImplementation(async () => ({ success: true }));
    helpers.authFetch = vi.fn(async () => json(201, { file: { id: 'f9', name: 'plan.txt', status: 'processing' } }));
});

describe('KnowledgeTab: what the project knows', () => {
    it('lists files with their state, the linked bases without the files base, and the project memory', async () => {
        renderTab('editor');
        expect(await screen.findByText('brief.pdf')).toBeInTheDocument();
        expect(within(screen.getByTestId('project-file-f2')).getByText('Indexing…')).toBeInTheDocument();
        expect(within(screen.getByTestId('project-file-f3')).getByText('Could not be read')).toBeInTheDocument();
        expect(within(screen.getByTestId('project-file-f1')).getByText(/Olivia Owner/)).toBeInTheDocument();
        // Why a file failed, and that personal data in a ready one was replaced.
        expect(within(screen.getByTestId('project-file-f3')).getByText('The same file is already in this project.')).toBeInTheDocument();
        expect(within(screen.getByTestId('project-file-f1')).getByText('Personal data replaced')).toBeInTheDocument();
        expect(within(screen.getByTestId('project-file-f2')).queryByText('Personal data replaced')).not.toBeInTheDocument();
        expect(await screen.findByText('Handbook')).toBeInTheDocument();
        expect(screen.queryByText('Launch plan · Files')).not.toBeInTheDocument();
        const memory = screen.getByTestId('memory-panel');
        expect(memory).toHaveAttribute('data-project', 'p1');
        expect(memory).toHaveAttribute('data-can-edit', 'true');
    });

    it('says the files could not be loaded instead of claiming there are none', async () => {
        client.get.mockImplementation(routes({ '/api/projects/p1/files': new Error('HTTP 500') }));
        renderTab('editor');
        expect(await screen.findByText('The files of this project could not be loaded.')).toBeInTheDocument();
        expect(screen.queryByText(/No files yet/)).not.toBeInTheDocument();
    });

    it('says the linked bases could not be loaded when the server could not read them', async () => {
        client.get.mockImplementation(routes({ '/api/projects/p1/resources': { role: 'editor', knowledgeBases: null } }));
        renderTab('editor');
        expect(await screen.findByText('The knowledge bases of this project could not be loaded.')).toBeInTheDocument();
    });

    it('gives a viewer the lists and a read-only memory, without upload, delete, link or unlink', async () => {
        renderTab('viewer');
        await screen.findByText('brief.pdf');
        await screen.findByText('Handbook');
        expect(within(screen.getByTestId('studio-section-header')).getByRole('heading', { name: 'Knowledge' })).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Upload files' })).not.toBeInTheDocument();
        expect(screen.queryByTestId('project-files-dropzone')).not.toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Delete brief.pdf' })).not.toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Link knowledge base' })).not.toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Unlink Handbook' })).not.toBeInTheDocument();
        expect(screen.getByTestId('memory-panel')).toHaveAttribute('data-can-edit', 'false');
    });
});

describe('KnowledgeTab: files', () => {
    it('uploads a picked file as multipart into the project', async () => {
        const user = userEvent.setup();
        renderTab('editor');
        await screen.findByText('brief.pdf');
        await user.upload(screen.getByTestId('project-files-input'), new File(['hello'], 'plan.txt', { type: 'text/plain' }));
        await waitFor(() => expect(helpers.authFetch).toHaveBeenCalled());
        const [url, init] = helpers.authFetch.mock.calls[0] as [string, RequestInit];
        expect(url).toMatch(/\/api\/projects\/p1\/files$/);
        expect(init.method).toBe('POST');
        expect((init.body as FormData).get('file')).toBeInstanceOf(File);
    });

    it('shows the reason the server refused an upload next to the file', async () => {
        const user = userEvent.setup();
        helpers.authFetch = vi.fn(async () => json(422, { error: 'This file holds data your organisation does not allow.' }));
        renderTab('editor');
        await screen.findByText('brief.pdf');
        await user.upload(screen.getByTestId('project-files-input'), new File(['x'], 'ids.csv'));
        expect(await screen.findByText('This file holds data your organisation does not allow.')).toBeInTheDocument();
    });

    it('says a refusal the server names by code in the reader’s language', async () => {
        const user = userEvent.setup();
        helpers.authFetch = vi.fn(async () => json(409, { error: 'English from the server.', code: 'SOLUTION_HOLDS_NO_FILES' }));
        renderTab('editor');
        await screen.findByText('brief.pdf');
        await user.upload(screen.getByTestId('project-files-input'), new File(['x'], 'plan.txt'));
        expect(await screen.findByText(/A Studio Solution has no project files/)).toBeInTheDocument();
        expect(screen.queryByText('English from the server.')).not.toBeInTheDocument();
    });

    it('refuses a file over the size limit without sending it', async () => {
        renderTab('editor');
        await screen.findByText('brief.pdf');
        const big = new File(['x'], 'video.mp4');
        Object.defineProperty(big, 'size', { value: 21 * 1024 * 1024 });
        fireEvent.drop(screen.getByTestId('project-files-dropzone'), { dataTransfer: { files: [big], types: ['Files'] } });
        expect(await screen.findByText('Larger than the 20 MB limit.')).toBeInTheDocument();
        expect(helpers.authFetch).not.toHaveBeenCalled();
    });

    it('deletes a file after confirmation', async () => {
        const user = userEvent.setup();
        renderTab('editor');
        await user.click(await screen.findByRole('button', { name: 'Delete brief.pdf' }));
        await user.click(screen.getByTestId('confirm-dialog-confirm'));
        await waitFor(() => expect(client.delete).toHaveBeenCalledWith('/api/projects/p1/files/f1', { retry: false }));
    });
});

describe('KnowledgeTab: knowledge bases', () => {
    const undo = useUndoCapture();
    it('links a readable base of the same organisation', async () => {
        const user = userEvent.setup();
        renderTab('editor');
        await user.click(await screen.findByRole('button', { name: 'Link knowledge base' }));
        const dialog = await screen.findByRole('dialog', { name: 'Link a knowledge base' });
        expect(await within(dialog).findByText('Sales playbook')).toBeInTheDocument();
        expect(within(dialog).queryByText('Partner base')).not.toBeInTheDocument();
        expect(within(dialog).queryByText('Another project files')).not.toBeInTheDocument();
        expect(within(dialog).queryByRole('button', { name: 'Add Handbook' })).not.toBeInTheDocument();
        await user.click(within(dialog).getByRole('button', { name: 'Add Sales playbook' }));
        await waitFor(() => expect(client.put).toHaveBeenCalledWith(
            '/api/projects/p1/resources', { kind: 'knowledge_base', id: 'kb-2', attach: true }, { retry: false },
        ));
    });

    it('unlinks a base at once and calls the API only when the Undo toast runs out', async () => {
        const user = userEvent.setup();
        renderTab('editor');
        await user.click(await screen.findByRole('button', { name: 'Unlink Handbook' }));
        expect(screen.queryByRole('button', { name: 'Unlink Handbook' })).not.toBeInTheDocument();
        expect(client.put).not.toHaveBeenCalled();
        act(() => undo.last().onExpire());
        await waitFor(() => expect(client.put).toHaveBeenCalledTimes(1));
        expect(client.put).toHaveBeenCalledWith(
            '/api/projects/p1/resources', { kind: 'knowledge_base', id: 'kb-1', attach: false }, { retry: false },
        );
    });

    it('keeps the base linked on Undo and never calls the API', async () => {
        const user = userEvent.setup();
        renderTab('editor');
        await user.click(await screen.findByRole('button', { name: 'Unlink Handbook' }));
        act(() => undo.last().onUndo());
        expect(await screen.findByRole('button', { name: 'Unlink Handbook' })).toBeInTheDocument();
        expect(client.put).not.toHaveBeenCalled();
    });
});
