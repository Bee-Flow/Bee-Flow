/**
 * PDF, PowerPoint or the preview page, handed to the share sheet. What is
 * still being typed is saved first — a PDF missing the sentence you just
 * wrote is the bug nobody reports and everybody notices (the web flushes too).
 */

import { describeError } from '@/core/api/errors';
import { useToast } from '@/shared/ui';

import { useShareStudioDocument } from './mutations';
import type { ExportFormat } from '../api/endpoints';

export function useDocumentExport(id: string, name: string, flush: () => Promise<void>) {
    const { toast } = useToast();
    const share = useShareStudioDocument(id, { onError: (error) => toast(describeError(error).message, 'error') });
    const run = async (format: ExportFormat) => {
        try {
            await flush();
        } catch (error) {
            toast(describeError(error).message, 'error');
            return;
        }
        share.mutate({ name, format });
    };
    return { run, busy: share.isPending };
}
