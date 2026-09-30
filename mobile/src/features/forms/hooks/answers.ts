/**
 * A form's answers: the dashboard, the responses, one response, the export.
 *
 * The dashboard refetches every 30 seconds while it is on screen — no pulse
 * route, no socket: a submission that landed a minute ago is what a dashboard
 * is for (the web's useAnswersSummary). The last numbers stay up while a
 * refresh runs.
 */

import { keepPreviousData, useInfiniteQuery, useMutation, useQuery } from '@tanstack/react-query';

import { exportAnswersCsv, getAnswerRow, getAnswersSummary, listAnswerRows } from '../api/answers';
import { formKeys } from '../api/keys';
import { rangeToQuery, type AnswersRange } from '../model/answersRange';

export const ANSWERS_REFRESH_MS = 30_000;

export function useAnswersSummary(datatableId: string, range: AnswersRange) {
    const { from, to } = rangeToQuery(range);
    return useQuery({
        queryKey: formKeys.answersSummary(datatableId, from, to),
        queryFn: ({ signal }) => getAnswersSummary(datatableId, { from, to }, signal),
        enabled: Boolean(datatableId),
        refetchInterval: ANSWERS_REFRESH_MS,
        placeholderData: keepPreviousData,
    });
}

/** Every response, newest first, a page at a time; `focus` keeps those that answered one question. */
export function useAnswerRows(datatableId: string, focus: string | null) {
    return useInfiniteQuery({
        queryKey: formKeys.answerRows(datatableId, focus),
        queryFn: ({ pageParam, signal }) => listAnswerRows(datatableId, { focus, cursor: pageParam, signal }),
        initialPageParam: null as string | null,
        getNextPageParam: (last) => (last.hasMore && last.nextCursor ? last.nextCursor : undefined),
        enabled: Boolean(datatableId),
    });
}

/** One response, every question. */
export function useAnswerRow(datatableId: string, rowId: string | null) {
    return useQuery({
        queryKey: formKeys.answerRow(datatableId, rowId ?? ''),
        queryFn: ({ signal }) => getAnswerRow(datatableId, rowId ?? '', signal),
        enabled: Boolean(datatableId && rowId),
    });
}

/** The whole table as CSV, to the share sheet. */
export function useExportAnswers(datatableId: string, handlers: { onError?: (error: Error) => void } = {}) {
    return useMutation({
        mutationFn: (tableName: string) => exportAnswersCsv(datatableId, tableName),
        onError: handlers.onError,
    });
}
