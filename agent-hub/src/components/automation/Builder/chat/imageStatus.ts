/**
 * The one line under the builder composer about the pictures of the last
 * message, or null when there is nothing to say.
 *
 * The server shows an attached picture to a model that can see images and
 * reports what happened per turn (`images`): a model that cannot see images,
 * or a picture over the size or count cap, is said here in one line instead
 * of the assistant silently answering without it.
 */

import type { BuilderImageStatus } from '@/hooks/useAutomationBuilderStream';

type Translate = (key: string, fallback: string, params?: Record<string, unknown>) => string;

export function imageStatusHint(status: BuilderImageStatus | null | undefined, t: Translate): string | null {
    if (!status || status.attached < 1) return null;
    if (status.blind) {
        return t('automation_testing.assistant_images.blind', 'This model cannot see images, so the assistant did not see what you attached. Describe it in words, or pick a model that can see images.');
    }
    if (status.skipped === 1) {
        return t('automation_testing.assistant_images.skipped_one', 'One image was too large, or one too many, so the assistant did not see it.');
    }
    if (status.skipped > 1) {
        return t('automation_testing.assistant_images.skipped_many', '{count} images were too large, or too many, so the assistant did not see them.', { count: status.skipped });
    }
    return null;
}
