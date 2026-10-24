// @typecheck
/**
 * The other tabs a spreadsheet tab's formulas point at (`Klanten!A1`,
 * `Klanten!$L$2:$L$201`), read so the formulas can be computed.
 *
 * The formula engine (shared/expr/sheet.mjs) resolves a cross-tab reference
 * through `options.workbook`, keyed by tab NAME; without that tab's cells it
 * answers #REF!. The editor (GET /:id/sheet → `refTabs`) and the chat's
 * document_read (integrations/sheetDocumentTools.js) both need them; only the
 * tabs a formula names are read, so a sheet without cross-tab formulas costs
 * nothing extra.
 */

'use strict';

// A sheet name as the engine's tokenizer reads it, right before the `!`.
const TAB_REF = /([A-Za-z_][A-Za-z0-9_.]*)!/g;

/**
 * Names of the other tabs `cells`' formulas refer to, as they exist in `tabs`.
 * @param {Record<string, string>} cells  the active tab's typed cells
 * @param {{ id: string, name: string }[]} tabs
 * @param {string} activeTabId
 * @returns {{ id: string, name: string, datatableId: string }[]}
 */
function referencedTabs(cells, tabs, activeTabId) {
    const names = new Set();
    for (const raw of Object.values(cells || {})) {
        if (typeof raw !== 'string' || !raw.startsWith('=') || !raw.includes('!')) continue;
        for (const m of raw.matchAll(TAB_REF)) names.add(m[1]);
    }
    return /** @type {any[]} */ (tabs.filter((t) => t.id !== activeTabId && names.has(t.name)));
}

/**
 * The typed cells of every tab `cells` refers to, keyed by tab name.
 * @param {{ userId: string }} doc
 * @param {any[]} tabs
 * @param {string} activeTabId
 * @param {Record<string, string>} cells
 * @param {{ readSheet: Function }} sheetCells
 * @returns {Promise<Record<string, Record<string, string>>>}
 */
async function readReferencedTabs(doc, tabs, activeTabId, cells, sheetCells) {
    /** @type {Record<string, Record<string, string>>} */
    const out = {};
    for (const t of referencedTabs(cells, tabs, activeTabId)) {
        out[t.name] = (await sheetCells.readSheet(doc.userId, t.datatableId)).cells;
    }
    return out;
}

module.exports = { referencedTabs, readReferencedTabs };
