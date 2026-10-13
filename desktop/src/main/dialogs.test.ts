import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { noNextcloudFolder } from './dialogs.ts';
import { nextcloudSummary } from './nextcloud/summary.ts';

describe('noNextcloudFolder', () => {
    it('says no sync folder was found, with the bridge summary as detail', () => {
        const status = { installed: false, running: false, accounts: [] };
        assert.deepEqual(noNextcloudFolder(status), {
            type: 'info',
            title: 'No Nextcloud folder',
            message: 'Bee Flow could not find a Nextcloud sync folder on this computer.',
            detail: nextcloudSummary(status),
        });
    });
});
