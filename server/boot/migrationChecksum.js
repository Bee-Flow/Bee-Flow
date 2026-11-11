// @typecheck strict
'use strict';
/**
 * The ledger checksum of a boot migration (boot/bootMigrations.js): the
 * sha256 of its file, so a changed file runs again on the next boot.
 *
 * An entry whose behaviour depends on files besides its own is listed in
 * CHECKSUM_EXTRA; its checksum then also covers what that function returns,
 * so a change in those files runs it again too. Every other entry's checksum
 * is the sha256 of its file alone, byte for byte what it has always been, so
 * a database that recorded it does not run it again.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');

/** @type {Readonly<Record<string, () => string>>} */
const CHECKSUM_EXTRA = Object.freeze({
    // Seeds every i18n/defaults/nl/<namespace>.json: a new or changed data file runs it again.
    'add-nl-namespace-files': () => require('../i18n/defaults/nl').sourceHash(),
});

/**
 * @param {string} name a file name under server/migrations/, without .js
 * @returns {string} hex sha256
 */
function checksumOf(name) {
    const file = require.resolve(`../migrations/${name}`);
    const hash = crypto.createHash('sha256').update(fs.readFileSync(file));
    const extra = Object.prototype.hasOwnProperty.call(CHECKSUM_EXTRA, name) ? CHECKSUM_EXTRA[name] : undefined;
    if (extra) hash.update(`\0${extra()}`);
    return hash.digest('hex');
}

module.exports = { checksumOf };
