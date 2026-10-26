// The Meeting Notes reads that feed the library: the notes themselves, the tag
// vocabulary, and the summary templates (personal and organisation-wide).

import { keepPreviousData, useQuery } from '@tanstack/react-query';
import * as api from '../transcriptionsApi';

const meetingLibraryKeys = {
    all: ['meeting-library'] as const,
    notes: () => ['meeting-library', 'notes'] as const,
    tags: () => ['meeting-library', 'tags'] as const,
    templates: () => ['meeting-library', 'templates'] as const,
    orgTemplates: () => ['meeting-library', 'org-templates'] as const,
};

/** The cache key of the notes list, for the local edits the library makes (rename, delete, upsert). */
export const meetingNotesKey = meetingLibraryKeys.notes();

type Note = Awaited<ReturnType<typeof api.listTranscriptions>>[number];

/**
 * The library's notes. While any note is still transcribing (an async
 * pipeline) the list re-reads itself every 4 s, so a spinner flips to the
 * finished note without a manual refresh; the interval stops with the last
 * processing note.
 */
export function useTranscriptionsQuery() {
    return useQuery({
        queryKey: meetingNotesKey,
        queryFn: () => api.listTranscriptions(),
        staleTime: 0,
        retry: false,
        refetchInterval: (query) => ((query.state.data as Note[] | undefined)?.some((n) => n.status === 'processing') ? 4000 : false),
    });
}

interface RawTagCount { tag: string; count: number | string }

/** `GET /api/transcriptions/tags`: counts over EVERY note the caller may read. An unreadable answer is null (the chips fall back to the rows on screen). */
export function useMeetingTagCountsQuery(refreshKey: number) {
    return useQuery({
        queryKey: [...meetingLibraryKeys.tags(), refreshKey],
        queryFn: async (): Promise<{ tag: string; count: number }[] | null> => {
            try {
                const list = await api.listTranscriptionTags();
                return list
                    .filter((r: RawTagCount) => r && typeof r.tag === 'string' && r.tag)
                    .map((r: RawTagCount) => ({ tag: r.tag, count: Number(r.count) || 0 }));
            } catch {
                return null;
            }
        },
        staleTime: 0,
        retry: false,
        placeholderData: keepPreviousData,
    });
}

/** The caller's summary templates (builtins plus personal). A refusal means Meeting Notes is not available: the query errors. */
export function useSummaryTemplatesQuery() {
    return useQuery({
        queryKey: meetingLibraryKeys.templates(),
        queryFn: () => api.listSummaryTemplates(),
        staleTime: 0,
        retry: false,
    });
}

/** The organisation's and groups' summary templates, with the builtins (those are best-effort). */
export function useOrgSummaryTemplatesQuery() {
    return useQuery({
        queryKey: meetingLibraryKeys.orgTemplates(),
        queryFn: async () => {
            const [orgData, list] = await Promise.all([
                api.listOrgSummaryTemplates(),
                api.listSummaryTemplates().catch(() => null),
            ]);
            return { org: orgData, builtins: list?.builtins ?? null };
        },
        staleTime: 0,
        retry: false,
    });
}
