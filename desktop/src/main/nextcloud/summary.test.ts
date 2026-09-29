import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { NextcloudStatus } from '../../shared/types.ts';
import { hostOf, nextcloudSummary } from './summary.ts';

const account = (url: string, folders: number) => ({
    id: '0',
    url,
    user: 'tom',
    folders: Array.from({ length: folders }, (_, i) => ({
        localPath: `/home/tom/Nextcloud${i}`,
        targetPath: '/',
        accountId: '0',
        virtualFiles: false,
    })),
});

describe('nextcloudSummary', () => {
    it('says the client is missing when it is', () => {
        assert.equal(nextcloudSummary({ installed: false, running: false, accounts: [] }), 'Desktop client not found');
    });

    it('names the server and counts the folders when connected', () => {
        const status: NextcloudStatus = { installed: true, running: true, accounts: [account('https://cloud.example.com', 2)] };
        assert.equal(nextcloudSummary(status), 'Connected — cloud.example.com, 2 folders');
    });

    it('distinguishes "installed" from "running", because the fix differs', () => {
        const status: NextcloudStatus = { installed: true, running: false, accounts: [account('https://cloud.example.com', 1)] };
        assert.equal(nextcloudSummary(status), 'Found cloud.example.com, 1 folder (client not running)');
    });

    it('counts accounts rather than naming one when there are several', () => {
        const status: NextcloudStatus = {
            installed: true,
            running: true,
            accounts: [account('https://a.example', 1), account('https://b.example', 3)],
        };
        assert.equal(nextcloudSummary(status), 'Connected — 2 accounts, 4 folders');
    });

    it('does not throw on an account whose URL is nonsense', () => {
        assert.equal(hostOf('not a url'), 'not a url');
    });
});
