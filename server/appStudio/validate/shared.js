// @typecheck
/**
 * App Studio validator — helpers shared by the validate/ modules.
 */

'use strict';

function isObject(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }

// Data-reference finding — an error normally (publish), demoted to a warning
// when the caller opted in via opts.dataRefsAsWarnings (human draft saves).
/**
 * @param {{ code: string; severity: string; path: string; message: string; hint: string; }} rec
 */
function pushDataRef(ctx, rec) {
    if (ctx.dataRefsAsWarnings) ctx.pushW({ ...rec, severity: 'warning' });
    else ctx.pushE(rec);
}

module.exports = { isObject, pushDataRef };

/**
 * @typedef {{ code: string; severity: string; path: string; message: string; hint: string; kind?: string; targetRef?: { kind: string; id: string | null; title?: string; path: string; nodeId: string | null; }; }} Finding
 * @typedef {object} ValidationCtx The shared context every phase of the walk reads (built in validate.js).
 * @property {(rec: Finding) => void} pushE
 * @property {(rec: Finding) => void} pushW
 * @property {Set<string>} actionIds
 * @property {Set<string>} screenIds
 * @property {Set<string>} roleIds
 * @property {Set<string> | null} knownVars
 * @property {string[] | null} knownVarList
 * @property {Set<string>} varReads
 * @property {Set<string>} modalIds
 * @property {Set<string>} formIds
 * @property {Map<string, Set<string>>} inputNamesByForm
 * @property {Set<string>} allInputNames
 * @property {Map<string, true | Record<string, any>> | null} ownedAutomations
 * @property {Map<string, Record<string, any>> | null} ownedDocuments
 * @property {Set<string> | null} knownTables
 * @property {Set<string> | null} knownDatasets
 * @property {Map<string, Set<string>> | null} dataTables
 * @property {Map<string, any> | null} dataTableSources
 * @property {Set<string> | null} knownDatatables
 * @property {Set<string> | null} dataDatasets
 * @property {Set<string> | null} dataConnectors
 * @property {Set<string> | null} dataMailboxConnectors
 * @property {boolean} dataRefsAsWarnings
 * @property {boolean} aiBrowsingEnabled
 * @property {{ id?: string | null, title?: string }} [target]
 */
