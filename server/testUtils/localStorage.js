// @typecheck strict
'use strict';
/**
 * The REAL stores/storageStore on its local-disk backend, in a temp directory,
 * for a test of code that reads or writes stored files and must not need S3.
 *
 * The seam is the store's own local mode (no RUSTFS_* variables) with
 * STORAGE_LOCAL_ROOT pointing at a temp dir: uploadFile / streamFile /
 * deleteFile run their real code, and nothing is put in the module cache.
 *
 *   const storage = useLocalStorage();
 *   test.before(storage.ready);
 *   test.after(storage.close);
 *   await storage.put('users/u1/a.png', PNG_BYTES, 'image/png');
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

function useLocalStorage() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'beeflow-storage-'));
    for (const name of ['RUSTFS_ENDPOINT', 'RUSTFS_ACCESS_KEY', 'RUSTFS_SECRET_KEY']) delete process.env[name];
    process.env.STORAGE_LOCAL_ROOT = root;
    const store = require('../stores/storageStore');
    return {
        store,
        root,
        /** Initialise the store on the temp directory. */
        async ready() { await store.init(); },
        /**
         * @param {string} key
         * @param {Buffer | string} bytes
         * @param {string} contentType
         */
        async put(key, bytes, contentType) { await store.uploadFile(key, Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes), contentType); },
        close() { fs.rmSync(root, { recursive: true, force: true }); },
    };
}

module.exports = { useLocalStorage };
