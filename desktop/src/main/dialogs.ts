/**
 * Message boxes the app shows from more than one place, as data: the caller
 * hands them to `dialog.showMessageBox`. Keeping them here keeps the wording
 * identical wherever they appear.
 */

import type { NextcloudStatus } from '../shared/types.ts';
import { NO_PAIRING_TARGET, type PairingResult } from './nextcloud/pairing.ts';
import { nextcloudSummary } from './nextcloud/summary.ts';

export interface InfoMessage {
    type: 'info' | 'error';
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

/** How a Nextcloud pairing went, in plain words, for the menu and deep-link entry points. */
export function pairingOutcome(result: PairingResult): InfoMessage {
    if (result.ok) {
        return {
            type: 'info',
            title: 'Nextcloud linked',
            message: `Linked ${result.loginName} at ${result.server}.`,
            detail: result.storedOnServer
                ? 'Your Bee Flow server stored the app password, so it can read your Nextcloud files.'
                : 'Your Bee Flow server did not store the app password (you may be signed out). Sign in and link again to use your Nextcloud files in Bee Flow.',
        };
    }
    if (result.error === NO_PAIRING_TARGET) {
        return {
            type: 'info',
            title: 'Link a Nextcloud account',
            message: NO_PAIRING_TARGET,
            detail:
                'Open a beeflow://nextcloud?server=<your Nextcloud address> link, for example beeflow://nextcloud?server=https://cloud.example.com, ' +
                'or install the Nextcloud desktop client and add your account there. You can also save the address in Bee Flow under Settings, Integrations.',
        };
    }
    return { type: 'error', title: 'Nextcloud was not linked', message: 'Bee Flow could not link your Nextcloud account.', detail: result.error };
}
