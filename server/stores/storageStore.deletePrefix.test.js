/**
 * Storage Store, deletePrefix: everything under a person's prefix goes,
 * nothing next to it does, and a prefix that is not a directory path of two
 * or more segments is refused before anything is touched. Local-disk mode
 * (no RUSTFS_* in the environment), on a temp root.
 *
 * Run: cd server && node --test stores/storageStore.deletePrefix.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-storage-prefix-'));
process.env.STORAGE_LOCAL_ROOT = root;
delete process.env.RUSTFS_ENDPOINT;
delete process.env.RUSTFS_ACCESS_KEY;
delete process.env.RUSTFS_SECRET_KEY;

const storageStore = require('./storageStore');

test('deletePrefix removes every object under the prefix and leaves the neighbours alone', async () => {
    assert.strictEqual(await storageStore.init(), true);
    await storageStore.uploadFile('users/u1/images/a.png', Buffer.from('a'), 'image/png');
    await storageStore.uploadFile('users/u1/webpages/w1/index.html', Buffer.from('<p>'), 'text/html');
    await storageStore.uploadFile('users/u1/audio/rec.webm', Buffer.from('x'), 'audio/webm');
    await storageStore.uploadFile('users/u10/images/b.png', Buffer.from('b'), 'image/png');
    await storageStore.uploadFile('shared/avatars/u1.png', Buffer.from('c'), 'image/png');

    assert.strictEqual(await storageStore.deletePrefix('users/u1/'), 3);
    assert.strictEqual(fs.existsSync(path.join(root, 'users', 'u1')), false);
    assert.strictEqual(fs.existsSync(path.join(root, 'users', 'u10', 'images', 'b.png')), true, 'a prefix is a directory, not a string match');
    assert.strictEqual(fs.existsSync(path.join(root, 'shared', 'avatars', 'u1.png')), true);
    assert.strictEqual(await storageStore.deletePrefix('users/u1/'), 0, 'idempotent');
});

test('deletePrefix refuses anything that is not a directory-shaped prefix of two or more segments', async () => {
    for (const bad of ['users/', 'users', '', 'users/u1', 'users/../u1/', '/users/u1/', 'users/u1//']) {
        await assert.rejects(() => storageStore.deletePrefix(bad), /directory-shaped prefix/, JSON.stringify(bad));
    }
    assert.strictEqual(fs.existsSync(path.join(root, 'users', 'u10', 'images', 'b.png')), true);
});
