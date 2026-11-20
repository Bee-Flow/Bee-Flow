// A new document from one of the reader's own templates: the server copies the
// template (its content, design and fields, and the link that offers "Update
// available" later) into a private document, the same copy the library's
// "Make a copy" makes. Then it is filed in the folder the library shows.

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { documentRequest, updateDocument } from '../documentsApi';
import { docKeys, type StudioDocument } from '../documentQueries';
import type { OwnTemplate } from './StarterGallery';

export function useTemplateCopy() {
    const qc = useQueryClient();
    return useMutation({
        mutationFn: async ({ template, folderId }: { template: OwnTemplate; folderId?: string }) => {
            const { document } = (await documentRequest(`/${encodeURIComponent(template.id)}/duplicate`, { kind: 'document', name: template.name })) as { document: StudioDocument };
            // Filing is best effort: the document exists either way, at the top of the library.
            if (folderId) await updateDocument(document.id, { folderId }).catch(() => undefined);
            return document;
        },
        onSuccess: () => qc.invalidateQueries({ queryKey: docKeys.all }),
    });
}
