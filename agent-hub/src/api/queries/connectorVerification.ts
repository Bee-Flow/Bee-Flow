// The Nextcloud connector's verification code (nextcloud-connector/src/setup.js,
// not a Bee Flow server route): asked once when the screen opens, and again on
// "send a new code". The answer comes back as postForBody reads it.

import { useMutation } from '@tanstack/react-query';
import { API_BASE } from '../mutate';
import { postForBody } from '../postForBody';

type PostAnswer = Awaited<ReturnType<typeof postForBody>>;

export function useRequestVerificationCodeMutation() {
    return useMutation<PostAnswer, Error, void>({
        mutationFn: () => postForBody(`${API_BASE}/setup/request-verification-code`, { method: 'POST' }),
    });
}
