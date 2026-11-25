/**
 * Shared set-up of the goal tests (./goalMeasure.test.js, usecases/coworkGoals.test.js): the real goal store
 * (stores/coworkGoals.mts) on PGlite next to a bare `cowork_schedules`, and a check built from a list of steps.
 */

'use strict';

const { before, after } = require('node:test');
const { pgliteDb } = require('../../../testUtils/pgliteDb');
const { makeCoworkGoals, COWORK_GOALS_DDL } = require('../../../stores/coworkGoals.mts');

const literal = (value) => ({ kind: 'literal', value });
const MANUAL = Object.freeze({ id: 'trg', type: 'trigger', kind: 'manual' });

/** A check definition from a list of steps, wired in order after its manual trigger. */
const checkOf = (steps, trigger = MANUAL) => ({
    trigger,
    steps,
    edges: steps.map((s, i) => ({ from: i === 0 ? trigger.id : steps[i - 1].id, to: s.id })),
});

/**
 * The goal store on a fresh PGlite, opened before the file's tests and closed after them (`onClose` first).
 * `addItem(prefix)` inserts a cowork item and answers its id.
 */
function goalStoreOnPglite({ onClose = () => {} } = {}) {
    const { pg, db } = pgliteDb();
    const store = makeCoworkGoals(db);
    let seq = 0;
    before(async () => {
        await pg.exec('CREATE TABLE cowork_schedules (id TEXT PRIMARY KEY)');
        for (const sql of COWORK_GOALS_DDL) await pg.exec(sql);
    });
    after(async () => { onClose(); await pg.close(); });
    const addItem = async (prefix = 'w') => {
        const id = `${prefix}${++seq}`;
        await pg.query('INSERT INTO cowork_schedules (id) VALUES ($1)', [id]);
        return id;
    };
    return { pg, db, store, addItem, nextSeq: () => ++seq };
}

module.exports = { literal, MANUAL, checkOf, goalStoreOnPglite };
