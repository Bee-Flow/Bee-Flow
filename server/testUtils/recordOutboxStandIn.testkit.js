// @typecheck
'use strict';

/**
 * A stand-in for the outbox of record triggers (stores/studioAppData/recordEvents.mts) for the
 * tests of the WRITE paths: it keeps what the write side handed it, so a test reads which
 * changes a write recorded and what it said on a trigger, against the real SQL of the write.
 *
 *   const outbox = standInOutbox(() => [{ appId, triggerId, config: { tableId, on } }]);
 *   beforeEach(() => outbox.install());            // empties it and wires recordOutbox.mts
 *   after(() => outbox.restore());
 *   outbox.recorded   the deliveries, in the order written
 *   outbox.notes      [triggerId, reason] of every skipped write shown on a trigger
 *   outbox.reads      how often the armed list was read
 *   outbox.limits     the limits the write side runs with (recordTriggerLimits({})), a copy a test may change
 */

const { _setOutboxDeps } = require('../appStudio/triggers/recordOutbox.mts');
const { recordTriggerLimits } = require('../appStudio/triggers/recordTriggerLimits.mts');

function standInOutbox(armed) {
    const outbox = {
        recorded: [], notes: [], reads: 0, limits: recordTriggerLimits({}),
        install(over = {}) {
            Object.assign(outbox, { recorded: [], notes: [], reads: 0, limits: recordTriggerLimits({}) });
            _setOutboxDeps({
                // Only what the write side calls; the rest of the store is not reached.
                store: () => /** @type {ReturnType<NonNullable<Parameters<typeof _setOutboxDeps>[0]['store']>>} */ (/** @type {unknown} */ ({
                    armedRecordTriggers: async () => { outbox.reads += 1; return armed(); },
                    add: async (list) => { outbox.recorded.push(...list); return { written: list.length, dropped: [] }; },
                    noteSkip: async (_appId, triggerId, _status, reason) => { outbox.notes.push([triggerId, reason]); },
                    ...over,
                })),
                now: () => 1_000_000,
                limits: () => outbox.limits,
                log: { warn() {} },
            });
        },
        restore: () => _setOutboxDeps({}),
    };
    return outbox;
}

module.exports = { standInOutbox };
