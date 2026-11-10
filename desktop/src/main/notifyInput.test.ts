import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { MAX_BODY, MAX_TITLE, readNotifyInput } from './notifyInput.ts';

describe('readNotifyInput', () => {
    it('answers null, not a TypeError, for a request that is not an object', () => {
        // `beeflow.notify()` from the page: the main process read `.title` of undefined.
        for (const input of [undefined, null, 'hello', 42, true]) {
            assert.equal(readNotifyInput(input), null);
        }
    });

    it('reads an ordinary request as it is', () => {
        assert.deepEqual(readNotifyInput({ title: 'Done', body: 'Your export is ready', silent: true, deepLink: 'beeflow://chat/1' }), {
            title: 'Done', body: 'Your export is ready', silent: true, deepLink: 'beeflow://chat/1',
        });
    });

    it('fills what is missing and bounds what is long', () => {
        assert.deepEqual(readNotifyInput({}), { title: 'Bee Flow', body: '', silent: false, deepLink: undefined });
        const long = readNotifyInput({ title: 't'.repeat(500), body: 'b'.repeat(5000) });
        assert.equal(long?.title.length, MAX_TITLE);
        assert.equal(long?.body.length, MAX_BODY);
    });

    it('takes each field for what it must be, whatever the page sent', () => {
        assert.deepEqual(readNotifyInput({ title: 7, body: null, silent: 'yes', deepLink: { href: 'x' } }), {
            title: '7', body: '', silent: false, deepLink: undefined,
        });
    });
});
