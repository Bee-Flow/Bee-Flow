// @typecheck strict
/**
 * App Studio validator — helpers shared by the validate/ modules.
 */

'use strict';

/** @param {unknown} v */
function isObject(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }

/** @typedef {{ code: string; severity: string; path: string; message: string; hint: string; }} DataRefRecord */

// Data-reference finding — an error normally (publish), demoted to a warning
// when the caller opted in via opts.dataRefsAsWarnings (human draft saves).
/**
 * @param {{ dataRefsAsWarnings?: boolean, pushW: (rec: DataRefRecord) => void, pushE: (rec: DataRefRecord) => void }} ctx
 * @param {DataRefRecord} rec
 */
function pushDataRef(ctx, rec) {
    if (ctx.dataRefsAsWarnings) ctx.pushW({ ...rec, severity: 'warning' });
    else ctx.pushE(rec);
}

module.exports = { isObject, pushDataRef };

/**
 * @typedef {{ code: string; severity: string; path: string; message: string; hint: string; kind?: string; targetRef?: { kind: string; id: string | null; title?: string; path: string; nodeId: string | null; }; }} Finding
 * @typedef {{
 *   pushE: (rec: Finding) => void, pushW: (rec: Finding) => void, actionIds: Set<string>, screenIds: Set<string>,
 *   roleIds: Set<string>, knownVars: Set<string> | null, knownVarList: string[] | null, varReads: Set<string>,
 *   modalIds: Set<string>, formIds: Set<string>, inputNamesByForm: Map<string, Set<string>>,
 *   allInputNames: Set<string>, ownedAutomations: Map<string, true | Record<string, any>> | null,
 *   ownedDocuments: Map<string, Record<string, any>> | null, knownTables: Set<string> | null,
 *   knownDatasets: Set<string> | null, dataTables: Map<string, Set<string>> | null,
 *   dataTableSources: Map<string, any> | null, knownDatatables: Set<string> | null, dataDatasets: Set<string> | null,
 *   dataConnectors: Set<string> | null, dataMailboxConnectors: Set<string> | null, dataRefsAsWarnings: boolean,
 *   aiBrowsingEnabled: boolean, target?: { id?: string | null, title?: string },
 * }} ValidationCtx  The shared context every phase of the walk reads (built in validate.js).
 */
