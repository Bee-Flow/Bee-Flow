/** "Archive …?" — asked the same way from the library row and from the editor. */

import { useTranslation } from '@/core/i18n';
import { useConfirm } from '@/shared/patterns';

export function useArchiveConfirm(): (name: string) => Promise<boolean> {
    const t = useTranslation();
    const confirm = useConfirm();
    return (name: string) =>
        confirm({
            title: t('mobile.studio_documents.archive_title', 'Archive “{name}”?', { name }),
            message: t(
                'mobile.studio_documents.archive_message',
                'It leaves your library. Versions that a routine or an app still uses stay available to them.',
            ),
            confirmLabel: t('mobile.studio_documents.archive', 'Archive'),
        });
}
