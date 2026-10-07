/**
 * Chat-signals hooks over a mocked HTTP client: a 404 reads as null, the
 * summary is not fetched until asked for, a save sets the cache, a refusal
 * carries its codes, and the DPIA goes as an attestation.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react-native';
import React, { type ReactNode } from 'react';

import { api, ApiError } from '@/core/api/client';

import {
    useChatSignalsActivity,
    useChatSignalsConfig,
    useChatSignalsSummary,
    useDeleteChatSignalCounts,
    useRecordChatSignalsDpia,
    useSaveChatSignals,
} from './chatSignals';
import { chatSignalsKeys, ChatSignalsSaveError } from '../api/chatSignals';
import type { ChatSignalsConfig } from '../api/chatSignalsReaders';
import { buildPutBody, formFromSettings } from '../model/chatSignals/form';

jest.mock('@/core/api/client', () => jest.requireActual('@/shared/testing/screenMocks').apiClient());

const get = api.get as jest.Mock;
const put = api.put as jest.Mock;
const post = api.post as jest.Mock;
const del = api.delete as jest.Mock;

function setup() {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { retry: false } } });
    const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
    return { queryClient, wrapper };
}

beforeEach(() => {
    for (const fn of [get, put, post, del]) fn.mockReset();
});

it('reads a 404 as null (an older server: the card hides)', async () => {
    get.mockRejectedValue(new ApiError('Not found', { status: 404 }));
    const { wrapper } = setup();
    const { result } = await renderHook(() => useChatSignalsConfig(), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toBeNull();
    expect(get).toHaveBeenCalledWith('/api/compliance/chat-monitoring', expect.objectContaining({ headers: { 'Cache-Control': 'no-store' } }));
});

it('surfaces other read failures', async () => {
    get.mockRejectedValue(new ApiError('Boom', { status: 500 }));
    const { wrapper } = setup();
    const { result } = await renderHook(() => useChatSignalsConfig(), { wrapper });
    await waitFor(() => expect(result.current.isError).toBe(true));
});

it('does not fetch the summary until the person asks for it', async () => {
    get.mockResolvedValue({ surfaces: { direct: { status: 'suppressed' } } });
    const { wrapper } = setup();
    const { result, rerender } = await renderHook(({ on }: { on: boolean }) => useChatSignalsSummary(90, on), { wrapper, initialProps: { on: false } });
    expect(get).not.toHaveBeenCalled();
    await rerender({ on: true });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(get).toHaveBeenCalledWith('/api/compliance/chat-monitoring/summary', expect.objectContaining({ query: { days: 90 } }));
    expect(result.current.data?.surfaces[0]?.figures.status).toBe('suppressed');
});

it('sets the configuration from the save answer and refreshes the register, not the figures', async () => {
    put.mockResolvedValue({ settings: { enabled: true, surfaces: ['direct'] }, can_widen: true });
    const { queryClient, wrapper } = setup();
    queryClient.setQueryData(['compliance', 'ropa'], 'old');
    queryClient.setQueryData(chatSignalsKeys.summary(30), 'figures');
    const { result } = await renderHook(() => useSaveChatSignals(), { wrapper });
    const before = formFromSettings(
        { enabled: false, surfaces: [], signals: [], effective_from: null, retention_days: 90, legal_basis: null, lia_at: null, works_council: null, works_council_reason: null, works_council_at: null, works_council_scope: { surfaces: [], signals: [], max_retention_days: null }, dpia_ref: null, dpia_at: null, dpia_risk_level: null, dpo_advice_at: null, prior_consultation_at: null, notice_url: null, notice_published_at: null, enabled_at: null, enabled_by_name: null },
        new Date(),
    );
    await act(async () => { await result.current.mutateAsync(buildPutBody(before, { enabled: true, now: new Date() })); });
    expect(queryClient.getQueryData<ChatSignalsConfig>(chatSignalsKeys.config())?.settings.surfaces).toEqual(['direct']);
    expect(queryClient.getQueryState(['compliance', 'ropa'])?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(chatSignalsKeys.summary(30))?.isInvalidated).toBe(false);
});

it('throws a typed refusal with the 422 codes and the 403 flag', async () => {
    const { wrapper } = setup();
    const { result } = await renderHook(() => useSaveChatSignals(), { wrapper });
    const body = buildPutBody(formFromSettings(
        { enabled: false, surfaces: [], signals: [], effective_from: null, retention_days: 90, legal_basis: null, lia_at: null, works_council: null, works_council_reason: null, works_council_at: null, works_council_scope: { surfaces: [], signals: [], max_retention_days: null }, dpia_ref: null, dpia_at: null, dpia_risk_level: null, dpo_advice_at: null, prior_consultation_at: null, notice_url: null, notice_published_at: null, enabled_at: null, enabled_by_name: null },
        new Date(),
    ), { enabled: true, now: new Date() });

    put.mockRejectedValueOnce(new ApiError('missing', { status: 422, body: { code: 'chat_monitoring_preconditions', details: { missing: ['dpia', 'notice_url'] } } }));
    const refused = await act(async () => result.current.mutateAsync(body).catch((e: unknown) => e));
    expect(refused).toBeInstanceOf(ChatSignalsSaveError);
    expect(refused).toMatchObject({ status: 422, missing: ['dpia', 'notice_url'], forbidden: false });

    put.mockRejectedValueOnce(new ApiError('Only an organisation admin', { status: 403, body: { code: 'chat_monitoring_widen_forbidden' } }));
    const forbidden = await act(async () => result.current.mutateAsync(body).catch((e: unknown) => e));
    expect(forbidden).toMatchObject({ status: 403, forbidden: true, missing: [] });
});

it('records the DPIA as an attestation and deletes counts, refreshing the configuration', async () => {
    post.mockResolvedValue({});
    del.mockResolvedValue({ deleted: 4 });
    const { queryClient, wrapper } = setup();
    queryClient.setQueryData(chatSignalsKeys.config(), null);
    const dpia = await renderHook(() => useRecordChatSignalsDpia(), { wrapper });
    await act(async () => { await dpia.result.current.mutateAsync({ risk_level: 'high', expires_at: null, mitigations: ['a'] }); });
    expect(post).toHaveBeenCalledWith('/api/compliance/dpia/chat_monitoring', { mode: 'attestation', risk_level: 'high', expires_at: null, mitigations: ['a'] });
    expect(queryClient.getQueryState(chatSignalsKeys.config())?.isInvalidated).toBe(true);

    const counts = await renderHook(() => useDeleteChatSignalCounts(), { wrapper });
    let deleted = 0;
    await act(async () => { deleted = await counts.result.current.mutateAsync(); });
    expect(deleted).toBe(4);
    expect(del).toHaveBeenCalledWith('/api/compliance/chat-monitoring/counts');
});

it('reads the register activity only when enabled', async () => {
    get.mockResolvedValue({ activities: [{ activity_id: 'chat-compliance-signals', name: 'Chat signals' }] });
    const { wrapper } = setup();
    const { result, rerender } = await renderHook(({ on }: { on: boolean }) => useChatSignalsActivity(on), { wrapper, initialProps: { on: false } });
    expect(get).not.toHaveBeenCalled();
    await rerender({ on: true });
    await waitFor(() => expect(result.current.data?.activity?.name).toBe('Chat signals'));
});
