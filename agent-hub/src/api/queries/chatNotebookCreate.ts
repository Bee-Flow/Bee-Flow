// POST /api/notebooks for the chat workspace: the notebook a chat writes into
// is created the first time it has content.

import { useMutation } from '@tanstack/react-query';
import { apiRequest } from '../typedRequest';

export function useCreateNotebookMutation() {
    return useMutation<Response, Error, string>({
        mutationFn: (name) => apiRequest('POST /api/notebooks', { body: { name } }),
    });
}
