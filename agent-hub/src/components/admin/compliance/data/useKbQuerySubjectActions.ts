import { useMutation, useQueryClient } from '@tanstack/react-query';
import { fetchDownload, fetchJson, jsonInit, kbQueryLogUrls } from '@/api/complianceApi';
import { parseContent, type KqlContent } from '@/api/kbQueryLog.types';

/** Why a content call was refused, in the words the page picks a sentence for. */
export type KqlRefusal = 'dsr_request_required' | 'failed';

export function refusalOf(error: unknown): KqlRefusal | null {
    if (!error) return null;
    return (error as { code?: string }).code === 'dsr_request_required' ? 'dsr_request_required' : 'failed';
}

interface Target { userId: string; dsrRequestId: string | number }

/**
 * What the officer may do with one person's rows once an open data-subject
 * request is chosen: read the text, export it, erase it. Each call is a click,
 * never an effect, and the server records each before it answers.
 */
export function useKbQuerySubjectActions() {
    const queryClient = useQueryClient();
    const content = useMutation<KqlContent, Error, Target>({
        mutationFn: async ({ userId, dsrRequestId }) => {
            const body = parseContent(await fetchJson(kbQueryLogUrls.content(userId, dsrRequestId)));
            if (!body) throw new Error('unusable answer');
            return body;
        },
    });
    const download = useMutation<void, Error, Target & { format: 'json' | 'csv' }>({
        mutationFn: ({ userId, dsrRequestId, format }) => fetchDownload(kbQueryLogUrls.subjectExport(userId, dsrRequestId, format), `kb-query-log-subject.${format}`),
    });
    const erase = useMutation<{ deleted: number }, Error, Target & { reason: string }>({
        mutationFn: async ({ userId, dsrRequestId, reason }) => {
            const body = await fetchJson(kbQueryLogUrls.erase(userId), jsonInit('DELETE', { dsrRequestId: Number(dsrRequestId), reason }));
            return { deleted: typeof body?.deleted === 'number' ? body.deleted : 0 };
        },
        onSuccess: () => { content.reset(); void queryClient.invalidateQueries({ queryKey: ['compliance', 'read', 'kb-query-log'] }); },
    });
    const refused = refusalOf(content.error) ?? refusalOf(download.error) ?? refusalOf(erase.error);
    return { content, download, erase, refused, reset: () => { content.reset(); download.reset(); erase.reset(); } };
}
