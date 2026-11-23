// The document a chat form fills in (api/templateFillApi.ts), cached per
// document and per answer: `revision` is how many template-fill results the
// answer holds for it, so a new tool result in a live turn reads it again.

import { useQuery } from '@tanstack/react-query';
import type { FillDocument } from '../templateFillApi';
import { useOptionalQueryClient } from './optionalQueryClient';

const templateFillKey = (id: string) => ['templateFill', id] as const;

export function useFillDocumentQuery(id: string, revision: number, load: (id: string) => Promise<FillDocument>) {
    const { client, attached } = useOptionalQueryClient();
    return useQuery<FillDocument, Error>({
        queryKey: [...templateFillKey(id), revision],
        enabled: attached && !!id,
        queryFn: () => load(id),
        retry: false,
    }, client);
}
