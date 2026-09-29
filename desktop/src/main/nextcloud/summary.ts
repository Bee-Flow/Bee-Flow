/**
 * One line that answers "is the bridge working, and if not, why not".
 *
 * Shown in the tray menu and on the settings page. It lives in its own module,
 * away from anything that imports `electron`, because the distinction it draws
 * is the one users get wrong most often — "the Nextcloud client is installed"
 * and "the Nextcloud client is running" have different fixes — and a sentence
 * that matters that much should be covered by a test.
 */

import type { NextcloudStatus } from '../../shared/types.ts';

export function nextcloudSummary(status: NextcloudStatus): string {
    if (!status.installed) return 'Desktop client not found';

    const accounts = status.accounts.length;
    const folders = status.accounts.reduce((total, account) => total + account.folders.length, 0);
    const where = accounts === 1 ? hostOf(status.accounts[0]?.url ?? '') : `${accounts} accounts`;
    const sync = `${folders} folder${folders === 1 ? '' : 's'}`;

    return status.running ? `Connected — ${where}, ${sync}` : `Found ${where}, ${sync} (client not running)`;
}

export function hostOf(url: string): string {
    try {
        return new URL(url).host;
    } catch {
        return url;
    }
}
