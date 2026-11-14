// The read behind the access editors (the Grants matrix and the organisation's
// access menu): one GET whose answer seeds the editor's toggles. A refusal or a
// failure keeps what the editor showed and says so through `onMessage`.

import { useQuery } from '@tanstack/react-query';
import { useTranslation } from '@/hooks/useTranslation';
import { messageOf } from '@/utils/caughtError';
import { request, RefusedError } from '@/api/mutate';

/** The status line an access editor shows. */
interface AccessMessage {
    type: 'ok' | 'error';
    text: string;
}

/** `T` is the editor's payload shape (components/admin/org/access/accessTypes.ts AccessData). */
export function useAccessRead<T>(kind: 'groupAccessMatrix' | 'orgAvailability', path: string, onMessage: (m: AccessMessage) => void) {
    const { t } = useTranslation();
    return useQuery<T>({
        queryKey: ['orgAdmin', kind, path],
        staleTime: 0,
        retry: false,
        // A reload after a failed save must reset the toggles even when the server's answer is unchanged.
        structuralSharing: false,
        queryFn: async () => {
            try {
                return (await (await request(path)).json()) as T;
            } catch (e) {
                onMessage({
                    type: 'error',
                    text: e instanceof RefusedError
                        ? t('admin_org.access_matrix_failed_load_status', 'Failed to load ({status})', { status: e.status })
                        : messageOf(e, t('admin_org.access_matrix_failed_load', 'Failed to load')),
                });
                throw e;
            }
        },
    });
}
