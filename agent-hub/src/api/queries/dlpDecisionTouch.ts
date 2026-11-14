// POST /api/chat/dlp-decision/touch: the heartbeat that keeps an open privacy
// review alive on the server while the person reads it. Best-effort: a failed
// beat is not shown (an expired decision reports through the submit).

import { useMutation } from '@tanstack/react-query';
import { apiRequest } from '../typedRequest';

export function useDlpDecisionTouchMutation() {
    return useMutation<Response, Error, string>({
        mutationFn: (decisionId) => apiRequest('POST /api/chat/dlp-decision/touch', { body: { decisionId } }),
    });
}
