/** Template writes: delete, and the upload queue a new .docx goes through. */

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';

import { pickDocuments, useUploadQueue } from '@/features/knowledge';
import { useToast } from '@/shared/ui';

import { deleteTemplate, templateUploadTarget } from '../api/endpoints';
import { templateKeys } from '../api/keys';

function useRefreshTemplates(): () => void {
    const queryClient = useQueryClient();
    return useCallback(() => {
        void queryClient.invalidateQueries({ queryKey: templateKeys.all });
    }, [queryClient]);
}

export function useDeleteTemplate(handlers: { onSuccess?: () => void } = {}) {
    const refresh = useRefreshTemplates();
    return useMutation({
        mutationFn: (id: string) => deleteTemplate(id),
        onSuccess: () => {
            handlers.onSuccess?.();
            refresh();
        },
    });
}

/**
 * Uploading templates. `skipAutoParameterize` is deliberately NOT set: letting
 * the server find the placeholders is the whole value of uploading here, and
 * it runs in the background after the 200.
 */
export function useTemplateUploads() {
    const { toast } = useToast();
    const refresh = useRefreshTemplates();
    const uploads = useUploadQueue(templateUploadTarget(), { onUploaded: refresh });

    const pick = useCallback(async () => {
        const files = await pickDocuments();
        // The route rejects anything not ending in .docx before it reads a
        // byte, so refusing here saves a pointless upload and says it better.
        const accepted = files.filter((f) => /\.docx$/i.test(f.name));
        if (accepted.length !== files.length) {
            toast('Templates have to be Word .docx files', 'error');
        }
        if (accepted.length) uploads.add(accepted);
    }, [uploads, toast]);

    return { uploads, pick };
}
