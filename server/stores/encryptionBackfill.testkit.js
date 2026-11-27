'use strict';
/**
 * The fake database and key contexts of the encryption backfill's tests
 * (encryptionBackfill.test.js and encryptionBackfill.meetingNotes.test.js).
 */

const crypto = require('crypto');

const USER_KEY = crypto.randomBytes(32);
const PROJECT_KEY = crypto.randomBytes(32);
const ALL_ON = { encryption_tier: 'managed', encryption_scope: null };

function ctxOf(key) {
    return {
        key, backgroundKey: key, tier: 'managed',
        encryptMessages: true, encryptMeta: true, encryptConversationMeta: true,
        encryptTitle: true, encryptNotebookMessages: true,
    };
}

/**
 * A tiny fake database: `tables` maps a table name to rows; getAll picks the
 * table out of the SQL, run records UPDATEs. `casMiss` forces rowCount 0.
 */
function fakeDeps({ org = ALL_ON, tables = {}, casMiss = false, resolve } = {}) {
    const updates = [];
    const resolved = [];
    const deps = {
        updates, resolved,
        async getOne(sql) {
            if (/FROM organizations/.test(sql)) return org ? { id: 'o1', ...org } : null;
            if (/COUNT\(\*\)/.test(sql)) return { n: (tables.transcriptions || []).length };
            return null;
        },
        async getAll(sql, params) {
            const m = sql.match(/FROM (\w+)/);
            const name = m && m[1];
            const cursor = params[0];
            return (tables[name] || []).filter(r => r.id > cursor).slice(0, params[2]);
        },
        async run(sql, params) { updates.push({ sql, params }); return { rowCount: casMiss ? 0 : 1 }; },
        async resolveCrypto(opts) {
            resolved.push(opts);
            if (resolve) return resolve(opts);
            return ctxOf(opts.projectKeyFor ? PROJECT_KEY : USER_KEY);
        },
    };
    return deps;
}

module.exports = { USER_KEY, PROJECT_KEY, ALL_ON, ctxOf, fakeDeps };
