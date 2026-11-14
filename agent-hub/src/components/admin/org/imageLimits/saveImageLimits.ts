import { ApiError } from '@/api/mutate';
import { apiRequest } from '@/api/typedRequest';
import { toast } from '@/components/shared/Toast';
import type { ImageLimits } from '@/utils/imageLimits';

/**
 * PUT one level's image limits (a member's `imageLimits`, a group's
 * `perUserImageLimits`), then re-read the directory. True when the server took
 * them; a refusal is a toast with the server's own sentence (else `failText`),
 * so the editor keeps what was typed.
 */
export async function saveImageLimits(
    target: { user: string } | { group: string },
    limits: ImageLimits | null,
    { fetchData, failText }: { fetchData: () => Promise<void> | void; failText: string },
): Promise<boolean> {
    try {
        if ('user' in target) await apiRequest('PUT /auth/users/{id}', { params: { id: target.user }, body: { imageLimits: limits } });
        else await apiRequest('PUT /auth/groups/{id}', { params: { id: target.group }, body: { perUserImageLimits: limits } });
    } catch (err) {
        if (!(err instanceof ApiError)) console.error('Failed to save image limits:', err);
        toast.error(err instanceof ApiError && err.message ? err.message : failText);
        return false;
    }
    await fetchData();
    return true;
}
