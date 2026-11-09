import type { TranslateFn } from '@/hooks/useTranslation';
import { errorCode, messageOf } from '@/utils/caughtError';

/**
 * The server's cloud error CODE as a sentence a person can act on, or null when
 * the code is not a cloud one (the caller then has its own wording).
 */
export function cloudErrorMessage(t: TranslateFn, e: unknown): string | null {
    switch (errorCode(e)) {
        case 'cloud_not_connected':
            return t('knowledge.cloud.err_not_connected', 'That cloud is not connected for your account. Connect it under Settings → Connections first.');
        case 'cloud_folder_unreadable':
            return t('knowledge.cloud.err_unreadable', 'That folder cannot be read. It may have been moved or deleted, or you may no longer have access.');
        case 'cloud_folder_out_of_scope':
            return t('knowledge.cloud.err_out_of_scope', 'Bee Flow may not read that folder yet. Allow it under Settings → Connections, then try again.');
        case 'no_original':
            return t('knowledge.originals.err_none', 'The original file was not kept for this document.');
        default:
            return null;
    }
}

/** `cloudErrorMessage`, falling back to the error's own text, then to `fallback`. */
export function cloudErrorOr(t: TranslateFn, e: unknown, fallback: string): string {
    return cloudErrorMessage(t, e) || messageOf(e, fallback);
}
