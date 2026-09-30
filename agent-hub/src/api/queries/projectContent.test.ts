import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { queryWrapper } from '../../test/queryWrapper';

// Fresh spies per test (assigned in beforeEach) rather than reset ones.
const { client, helpers } = vi.hoisted(() => ({
    client: {} as Record<'get' | 'post' | 'put' | 'delete', ReturnType<typeof vi.fn>>,
    helpers: { authFetch: (() => {}) as unknown as Mock<(...args: unknown[]) => Promise<Response>> },
}));
vi.mock('../client', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../client')>()),
    apiClient: client,
    default: client,
}));
vi.mock('../../utils/helpers', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../../utils/helpers')>()),
    authFetch: (...args: unknown[]) => helpers.authFetch(...args),
}));

import {
    useCreateProjectDocument, useMyMeetingsQuery, useProjectFilesQuery, useProjectSection, useUploadProjectFile,
} from './projectContent';

beforeEach(() => {
    for (const m of ['get', 'post', 'put', 'delete'] as const) client[m] = vi.fn();
    helpers.authFetch = vi.fn();
});

describe('useProjectSection', () => {
    const run = async (resources: unknown) => {
        client.get.mockImplementation(async () => resources);
        const { result } = renderHook(() => useProjectSection('p1', 'documents'), { wrapper: queryWrapper() });
        await waitFor(() => expect(result.current.status).not.toBe('loading'));
        return result.current;
    };

    it('passes a filed list through', async () => {
        expect(await run({ documents: [{ id: 'd1', name: 'A' }] })).toMatchObject({ status: 'ok', items: [{ id: 'd1' }] });
    });

    it('reads a section the server could not load (null) as an error, never as empty', async () => {
        expect((await run({ documents: null })).status).toBe('error');
    });

    it('reads a section the server left out as an error too', async () => {
        expect((await run({ notebooks: [] })).status).toBe('error');
    });

    it('reads a section the project’s kind does not hold as empty, not as a failure', async () => {
        // GET /:id/resources lists only the sections a kind holds, and says
        // which kind it answered for: a Studio Solution has no documents.
        expect(await run({ kind: 'solution', notebooks: [] })).toMatchObject({ status: 'ok', items: [] });
        expect((await run({ kind: 'solution', documents: null })).status).toBe('error');
    });
});

describe('project files', () => {
    it('asks again while a file is still being indexed', async () => {
        client.get.mockImplementation(async () => ({ files: [{ id: 'f1', name: 'a.pdf', status: 'processing' }], kbId: 'kb1' }));
        const { result } = renderHook(() => useProjectFilesQuery('p1'), { wrapper: queryWrapper() });
        await waitFor(() => expect(result.current.data?.kbId).toBe('kb1'));
        expect(client.get).toHaveBeenCalledWith('/api/projects/p1/files', expect.anything());
    });

    it('explains a 413 the proxy answered without a body', async () => {
        helpers.authFetch.mockImplementation(async () => new Response('<html>too large</html>', { status: 413 }));
        const { result } = renderHook(() => useUploadProjectFile('p1'), { wrapper: queryWrapper() });
        await expect(result.current.mutateAsync(new File(['x'], 'a.bin'))).rejects.toThrow('This file is larger than the upload limit');
    });

    it('refuses a 2xx that carries no file', async () => {
        helpers.authFetch.mockImplementation(async () => new Response('{}', { status: 201, headers: { 'content-type': 'application/json' } }));
        const { result } = renderHook(() => useUploadProjectFile('p1'), { wrapper: queryWrapper() });
        await expect(result.current.mutateAsync(new File(['x'], 'a.txt'))).rejects.toThrow('Could not upload the file');
    });
});

describe('create and pick', () => {
    it('refuses a created document without an id', async () => {
        client.post.mockImplementation(async () => ({}));
        const { result } = renderHook(() => useCreateProjectDocument('p1'), { wrapper: queryWrapper() });
        await expect(result.current.mutateAsync({ name: 'X' })).rejects.toThrow('Could not create the document');
    });

    it('offers only meetings the caller owns', async () => {
        client.get.mockImplementation(async () => ({ transcriptions: [{ id: 'm1', isOwner: true }, { id: 'm2', isOwner: false }] }));
        const { result } = renderHook(() => useMyMeetingsQuery(true), { wrapper: queryWrapper() });
        await waitFor(() => expect(result.current.data).toEqual([{ id: 'm1', isOwner: true }]));
    });
});
