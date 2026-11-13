import { API_BASE } from '@/utils/helpers';
import { mutate, ApiError } from '@/api/mutate';
import { toast } from '@/components/shared/Toast';
import type { ImageLimits } from '@/utils/imageLimits';

/**
 * PUT one level's image limits (a member's `imageLimits`, a group's
 * `perUserImageLimits`), then re-read the directory. True when the server took
 * them; a refusal is a toast with the server's own sentence (else `failText`),
 * so the editor keeps what was typed.
 */
export async function saveImageLimits(
    path: string,
    field: 'imageLimits' | 'perUserImageLimits',
    limits: ImageLimits | null,
    { fetchData, failText }: { fetchData: () => Promise<void> | void; failText: string },
): Promise<boolean> {
    try {
        await mutate(`${API_BASE}${path}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ [field]: limits }),
        });
    } catch (err) {
        if (!(err instanceof ApiError)) console.error('Failed to save image limits:', err);
        toast.error(err instanceof ApiError && err.message ? err.message : failText);
        return false;
    }
    await fetchData();
    return true;
}
