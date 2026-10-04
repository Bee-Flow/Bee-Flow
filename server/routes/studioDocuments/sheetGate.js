// @typecheck
/**
 * May this person have spreadsheets in Documents?
 *
 * A spreadsheet keeps its cells in a datatable (core/documents/sheet), so it
 * is offered to exactly the people who may use datatables: the gates in front
 * of /api/datatables (server/index.js and routes/datatables/index.js) — the
 * automation module, the `automations` licence feature and the `automations`
 * beta switch — run here in the same order, so the two can never disagree
 * about who has them.
 *
 * Not repeated: the datatables training gate. It guards designing tables
 * (creating one, changing its columns) and a spreadsheet designs nothing; its
 * columns are the platform's (managedTables `document_sheet`).
 *
 * Built like routes/projects/notebookGate.js, whose runner it uses:
 * `makeSheetGate({ gates })` takes the gates so a test runs it with fakes.
 *
 *   403 sheets_unavailable   module off, not in the plan, or the beta is off
 *   503 sheets_unknown       whether it is available could not be told
 */

'use strict';

const { HttpError } = require('../../core/http/errors');
const { runGate } = require('../projects/notebookGate');

/** @typedef {(req: any, res: any, next: (err?: unknown) => void) => unknown} Middleware */

/** The real gates, in the order /api/datatables applies them. */
function realGates() {
    const { requireModule } = require('../../modules');
    const { requireFeature } = require('../../license/middleware');
    const { requireBetaFeature } = require('../../core/entitlements/betaFeatures');
    return [requireModule('automation'), requireFeature('automations'), requireBetaFeature('automations')];
}

/**
 * @param {{ gates?: Middleware[] | (() => Middleware[]) }} [deps]
 * @returns {Middleware}
 */
function makeSheetGate(deps = {}) {
    /** @type {Middleware[] | null} */
    let gates = null;
    const bound = () => {
        if (!gates) gates = typeof deps.gates === 'function' ? deps.gates() : (deps.gates || realGates());
        return gates;
    };
    return async function requireSheetsMw(req, res, next) {
        for (const gate of bound()) {
            const refusal = await runGate(gate, req);
            if (!refusal) continue;
            if (refusal.status === 401) throw new HttpError(401, 'unauthorized', 'Authentication required');
            if (refusal.status >= 500) {
                throw new HttpError(503, 'sheets_unknown', 'Whether spreadsheets are available to you could not be checked. Try again in a moment.');
            }
            throw new HttpError(403, 'sheets_unavailable', 'Spreadsheets are not available to you: they keep their cells in Datatables, which your plan or role does not include.');
        }
        next();
    };
}

/**
 * The gate as a yes or no (the library list asks it to decide whether to
 * offer the type). Never throws.
 *
 * @param {Middleware} gate
 * @param {any} req
 */
async function sheetsVisible(gate, req) {
    try {
        await new Promise((resolve, reject) => {
            Promise.resolve()
                .then(() => gate(req, { set() { return this; } }, (/** @type {unknown} */ err) => (err ? reject(err) : resolve(undefined))))
                .catch(reject);
        });
        return true;
    } catch {
        return false;
    }
}

module.exports = { makeSheetGate, sheetsVisible, realGates };
