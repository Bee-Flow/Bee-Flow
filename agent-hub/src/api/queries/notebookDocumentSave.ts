// One whole-document save of a notebook page, compare-and-set when a version
// is known (PUT /api/notebooks/:id with expectedVersion). A 409 is the
// server's "someone else saved first": the caller decides what that means.

import { useMutation } from '@tanstack/react-query';
import { notebookApi } from '../notebookApi';

export interface DocumentSave {
    id: string;
    html: string;
    version: number | null;
}

export function useNotebookDocumentSaveMutation() {
    return useMutation<{ version?: number } | null, Error, DocumentSave>({
        mutationFn: ({ id, html, version }) => {
            const body: { documentContent: string; expectedVersion?: number } = { documentContent: html };
            if (version != null) body.expectedVersion = version;
            return notebookApi(`/${id}`, { method: 'PUT', body: JSON.stringify(body) }) as Promise<{ version?: number } | null>;
        },
    });
}
