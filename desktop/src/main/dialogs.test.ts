import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { NO_PAIRING_TARGET } from './nextcloud/pairing.ts';
import { noNextcloudFolder, pairingOutcome } from './dialogs.ts';
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

describe('pairingOutcome', () => {
    it('says who was linked where, and that the server stored it', () => {
        const message = pairingOutcome({ ok: true, server: 'https://cloud.example.com', loginName: 'ada', storedOnServer: true });
        assert.equal(message.type, 'info');
        assert.equal(message.message, 'Linked ada at https://cloud.example.com.');
        assert.match(message.detail, /server stored the app password/);
    });
    it('says when the server did not store it', () => {
        const message = pairingOutcome({ ok: true, server: 'https://cloud.example.com', loginName: 'ada', storedOnServer: false });
        assert.match(message.detail, /did not store/);
    });
    it('explains how to link when there is no address', () => {
        const message = pairingOutcome({ ok: false, error: NO_PAIRING_TARGET });
        assert.equal(message.type, 'info');
        assert.match(message.detail, /beeflow:\/\/nextcloud\?server=/);
        assert.match(message.detail, /desktop client/);
    });
    it('shows any other failure as an error with its words', () => {
        assert.deepEqual(pairingOutcome({ ok: false, error: 'Login timed out' }), {
            type: 'error',
            title: 'Nextcloud was not linked',
            message: 'Bee Flow could not link your Nextcloud account.',
            detail: 'Login timed out',
        });
    });
});
