/**
 * Message boxes the app shows from more than one place, as data: the caller
 * hands them to `dialog.showMessageBox`. Keeping them here keeps the wording
 * identical wherever they appear.
 */

import type { NextcloudStatus } from '../shared/types.ts';
import { nextcloudSummary } from './nextcloud/summary.ts';

export interface InfoMessage {
    type: 'info';
    title: string;
    message: string;
    detail: string;
}

/** No Nextcloud sync folder to open or pick from. */
export function noNextcloudFolder(status: NextcloudStatus): InfoMessage {
    return {
        type: 'info',
        title: 'No Nextcloud folder',
        message: 'Bee Flow could not find a Nextcloud sync folder on this computer.',
        detail: nextcloudSummary(status),
    };
}
