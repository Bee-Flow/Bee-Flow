// The Agent Studio's delete: DELETE /agents/:id, `?confirm=1` once the person
// confirmed an agent something still uses. The Response comes back untouched:
// a 409 is the "what uses this" answer the dialog shows, not a failure.

import { useMutation } from '@tanstack/react-query';
import { deleteAgentRequest } from '../agentStudio';

export interface DeleteAgentVars { agentId: string; force: boolean }

export function useDeleteAgentMutation() {
    return useMutation<Response, Error, DeleteAgentVars>({
        mutationFn: ({ agentId, force }) => deleteAgentRequest(agentId, force),
    });
}
