/**
 * The notes autosave over a mocked HTTP client: a pause saves with the
 * version it knew, an edit during a save is saved right after, a 409 loads
 * the server's copy instead of overwriting it, a failed save says so and
 * retries, and an edit still waiting is saved on the way out.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook } from '@testing-library/react-native';
import React, { type ReactNode } from 'react';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { api, ApiError } from '@/core/api/client';
import { ThemeProvider } from '@/core/theme/ThemeProvider';
import { TEST_METRICS } from '@/shared/testing/renderWithProviders';
import { ToastProvider } from '@/shared/ui';

import { AUTOSAVE_MS, useNoteDraft } from './useNoteDraft';
import type { Notebook } from '../model/types';

jest.mock('@/core/api/client', () => jest.requireActual('@/shared/testing/screenMocks').apiClient());

const get = api.get as jest.Mock;
const put = api.put as jest.Mock;

const notebook = (over: Partial<Notebook> = {}): Notebook => ({
    id: 'nb1',
    userId: 'u1',
    name: 'Test',
    description: '',
    instructions: '',
    knowledgeBaseIds: [],
    settings: {},
    documentContent: '<h1>Plan</h1>',
    documentMd: '# Plan',
    documentFormat: 'html',
    type: 'notebook',
    projectId: null,
    organizationId: null,
    version: 3,
    sourceCount: 0,
    lastEditedBy: null,
    lastEditedAt: null,
    createdAt: null,
    updatedAt: null,
    ...over,
});

function setup(initial: Notebook | null = notebook()) {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
    const wrapper = ({ children }: { children: ReactNode }) => (
        <SafeAreaProvider initialMetrics={TEST_METRICS}>
            <QueryClientProvider client={queryClient}>
                <ThemeProvider>
                    <ToastProvider>{children}</ToastProvider>
                </ThemeProvider>
            </QueryClientProvider>
        </SafeAreaProvider>
    );
    return renderHook(({ nb }: { nb: Notebook | null }) => useNoteDraft('nb1', nb), { wrapper, initialProps: { nb: initial } });
}

const flush = async (ms = AUTOSAVE_MS) => {
    await act(async () => {
        jest.advanceTimersByTime(ms);
        await Promise.resolve();
    });
};

beforeEach(() => {
    jest.useFakeTimers();
    get.mockReset();
    put.mockReset();
});
afterEach(() => jest.useRealTimers());

it('opens the Markdown mirror and saves Markdown after a pause, with the version it knew', async () => {
    put.mockResolvedValue({ success: true, version: 4 });
    const { result } = await setup();
    expect(result.current).toMatchObject({ text: '# Plan', editable: true, fromRichEditor: true, status: 'idle' });

    await act(async () => result.current.edit('# Plan\n\nMore'));
    expect(result.current.status).toBe('dirty');
    expect(put).not.toHaveBeenCalled();
    await flush();
    expect(put).toHaveBeenCalledWith('/api/notebooks/nb1', { documentContent: '# Plan\n\nMore', expectedVersion: 3 });
    expect(result.current.status).toBe('saved');

    await act(async () => result.current.edit('# Plan\n\nMore!'));
    await flush();
    expect(put).toHaveBeenLastCalledWith('/api/notebooks/nb1', { documentContent: '# Plan\n\nMore!', expectedVersion: 4 });
});

it('loads the server’s copy on a conflict instead of overwriting it', async () => {
    put.mockRejectedValue(new ApiError('Document was updated elsewhere', { status: 409 }));
    get.mockResolvedValue({ notebook: notebook({ documentContent: '# Theirs', documentMd: '# Theirs', version: 9 }), sources: [] });
    const { result } = await setup();
    await act(async () => result.current.edit('# Mine'));
    await flush();
    await act(async () => {
        await Promise.resolve();
    });
    expect(get).toHaveBeenCalledWith('/api/notebooks/nb1', expect.anything());
    expect(result.current).toMatchObject({ text: '# Theirs', status: 'idle' });
});

it('says a save failed, and saves again on retry', async () => {
    put.mockRejectedValueOnce(new ApiError('Server unavailable', { status: 503 })).mockResolvedValue({ success: true, version: 4 });
    const { result } = await setup();
    await act(async () => result.current.edit('# Plan 2'));
    await flush();
    expect(result.current.status).toBe('error');
    expect(result.current.error).toBeTruthy();
    await act(async () => {
        result.current.retry();
        await Promise.resolve();
    });
    expect(result.current.status).toBe('saved');
});

it('adopts a newer server copy only while nothing here is unsaved', async () => {
    const { result, rerender } = await setup();
    await act(async () => rerender({ nb: notebook({ documentMd: '# AI wrote this', version: 5 }) }));
    expect(result.current.text).toBe('# AI wrote this');
    await act(async () => result.current.edit('# Typing'));
    await act(async () => rerender({ nb: notebook({ documentMd: '# AI again', version: 6 }) }));
    expect(result.current.text).toBe('# Typing');
});

it('appends a chat answer, and saves an edit still waiting when the screen closes', async () => {
    put.mockResolvedValue({ success: true, version: 4 });
    const { result, unmount } = await setup();
    await act(async () => result.current.append('The answer'));
    expect(result.current.text).toBe('# Plan\n\nThe answer\n');
    await act(async () => unmount());
    expect(put).toHaveBeenCalledWith('/api/notebooks/nb1', { documentContent: '# Plan\n\nThe answer\n' });
});

it('will not edit a web document the server could not mirror', async () => {
    const { result } = await setup(notebook({ documentMd: null, documentContent: '<p>x</p>' }));
    expect(result.current.editable).toBe(false);
    await act(async () => result.current.edit('overwrite'));
    expect(result.current.text).toBe('');
    await flush();
    expect(put).not.toHaveBeenCalled();
});
