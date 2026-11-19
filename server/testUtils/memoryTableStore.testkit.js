/**
 * A table store over memory, for tests that run the table steps for real
 * (read_table, table, write_table, a Loop over a table) without a database or
 * object storage: the real writer and reader (gzip lines through a temp file)
 * over an in-memory ledger and blob map, every run in one journey.
 *
 *   const mem = memoryTableStore();
 *   mem.store.writeTable(...) / mem.store.openTable(...)   the tableStore surface
 *   mem.keepGeneratedFile(args)                           a generated_file ledger row
 *   mem.files                                             the kept files, by id
 */

'use strict';

const fs = require('node:fs');
const { Readable } = require('node:stream');
const { makeTableStore } = require('../core/automationRunner/tables/tableStore');
const { tableLimits } = require('../core/automationRunner/tables/limits');

function memoryTableStore({ limits = tableLimits({}) } = {}) {
    const ledger = new Map();
    const blobs = new Map();
    const files = new Map();
    const ledgerStore = {
        async recordRunTable(row) { ledger.set(row.id, { ...row }); return row; },
        async getRunTableForAutomation(id, automationId) {
            const row = ledger.get(id);
            return row && row.automationId === automationId ? { ...row } : null;
        },
        async countRunTablesForRun(runId) { return [...ledger.values()].filter((r) => r.runId === runId).length; },
        async getRun(id) { return { id, startedByUserId: 'u1' }; },
    };
    const storage = {
        isAvailable: () => true,
        buildAutomationFileKey: (owner, automation, name) => `mem/${owner}/${automation}/${name}`,
        async uploadFileFromPath(key, path) { blobs.set(key, fs.readFileSync(path)); return { key }; },
        async streamFile(key) { return { stream: Readable.from([blobs.get(key)]) }; },
        async deleteFile(key) { blobs.delete(key); },
    };
    const store = makeTableStore({ store: ledgerStore, storage, journeyRunIds: async (scope) => [scope.runId], limits: () => limits });
    let nextFile = 1;
    return {
        store,
        files,
        async keepGeneratedFile({ buffer, filename, contentType }) {
            const id = `gf_${nextFile++}`;
            files.set(id, { buffer, filename, contentType });
            return { id };
        },
    };
}

module.exports = { memoryTableStore };
