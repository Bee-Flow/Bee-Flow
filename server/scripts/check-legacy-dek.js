#!/usr/bin/env node
'use strict';

/**
 * How many accounts still depend on the legacy encryption paths?
 *
 *   - users with "masterWrappedDEK" set: a DEK wrapped by the server's master
 *     key (the pre-zero-knowledge scheme);
 *   - users with "wrappedDEK" but no "kekSalt": a password-wrapped DEK without
 *     the per-user salt of the current scheme.
 *
 * READ-ONLY. One SELECT inside a READ ONLY transaction; nothing is changed and
 * no encryption code is touched. The output is two numbers: no user ids, names,
 * e-mail addresses or key material.
 *
 * Run: cd server && node scripts/check-legacy-dek.js [--json]
 */

/** A column counts as set when it holds something other than NULL or ''. */
const COUNT_SQL = `
    SELECT
        COUNT(*) FILTER (WHERE NULLIF("masterWrappedDEK", '') IS NOT NULL) AS master_wrapped,
        COUNT(*) FILTER (WHERE NULLIF("wrappedDEK", '') IS NOT NULL
                           AND NULLIF("kekSalt", '') IS NULL)            AS wrapped_without_salt
    FROM users`;

/**
 * @param {{ query: (sql: string) => Promise<{ rows: any[] }> }} db  a pg client or pool
 * @returns {Promise<{ masterWrappedDEK: number, wrappedDEKWithoutKekSalt: number }>}
 */
async function countLegacyDek(db) {
    await db.query('BEGIN TRANSACTION READ ONLY');
    try {
        const { rows } = await db.query(COUNT_SQL);
        const row = rows[0] || {};
        return {
            // COUNT(*) is a bigint, which node-postgres hands back as a string.
            masterWrappedDEK: Number(row.master_wrapped || 0),
            wrappedDEKWithoutKekSalt: Number(row.wrapped_without_salt || 0),
        };
    } finally {
        await db.query('ROLLBACK');
    }
}

/** @param {{ masterWrappedDEK: number, wrappedDEKWithoutKekSalt: number }} counts */
function formatReport(counts, { json = false } = {}) {
    if (json) return JSON.stringify(counts);
    return [
        `users with masterWrappedDEK set:          ${counts.masterWrappedDEK}`,
        `users with wrappedDEK but no kekSalt:     ${counts.wrappedDEKWithoutKekSalt}`,
    ].join('\n');
}

async function main(argv = process.argv.slice(2)) {
    require('dotenv').config({ quiet: true });
    const { pool, disconnectRedis } = require('../db');
    const client = await pool.connect();
    try {
        const counts = await countLegacyDek(client);
        process.stdout.write(`${formatReport(counts, { json: argv.includes('--json') })}\n`);
    } finally {
        client.release();
        await disconnectRedis();
        await pool.end();
    }
}

if (require.main === module) {
    main().catch((err) => {
        console.error('check-legacy-dek failed:', err.message);
        process.exitCode = 1;
    });
}

module.exports = { countLegacyDek, formatReport, COUNT_SQL };
