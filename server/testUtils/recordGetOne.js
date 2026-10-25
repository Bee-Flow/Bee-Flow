// @typecheck strict
'use strict';

/**
 * Replace db.getOne on the shared db singleton with a recorder.
 *
 * A check that destructures getOne from db at require time keeps the function
 * it saw then, so call this BEFORE requiring the check:
 *
 *   const db = require('../../../db');
 *   const rec = recordGetOne(db);
 *   const check = require('./a8-15-logging');
 *   rec.answer = async (sql) => ({ c: 0 });   // per test
 *   rec.calls                                  // [{ sql, params }, …]
 *
 * @param {{ getOne: (sql: string, params?: unknown) => Promise<unknown> }} db
 */
function recordGetOne(db) {
    /** @type {{ calls: Array<{ sql: string, params: unknown }>, answer: (sql: string, params?: unknown) => Promise<unknown> }} */
    /** @type {{ calls: Array<{ sql: string, params: any }>, answer: (sql?: string, params?: any) => Promise<any> }} */
    const rec = { calls: [], answer: async () => null };
    db.getOne = async (/** @type {string} */ sql, /** @type {unknown} */ params) => { rec.calls.push({ sql, params }); return rec.answer(sql, params); };
    return rec;
}

module.exports = { recordGetOne };
