// @typecheck strict
/**
 * The feature-matrix block as one crawlable <table> (see renderBlocks.js, which
 * calls this for a node of that shape). Split out to keep renderBlocks.js
 * under the file-size ceiling.
 */

const { esc } = require('./html');

/** @typedef {Record<string, unknown>} Node */

/** @param {unknown} v @returns {v is string} */
const isProse = (v) => typeof v === 'string' && v.trim() !== '';

/** @param {unknown} v @returns {v is Node} */
const isNode = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * A feature matrix announces itself by shape too: `columns` (the licence
 * heads) plus `groups` (category name + rows with one cell per column).
 * @param {Node} node
 */
function isFeatureMatrix(node) {
    return Array.isArray(node.columns) && Array.isArray(node.groups);
}

/**
 * @param {unknown} cell
 * @param {Node} node  the block content, which holds the (translatable) words
 * @returns {string}  the cell as crawlable text
 */
function matrixCellText(cell, node) {
    if (!isNode(cell)) return '';
    if (cell.kind === 'included') return isProse(node.includedLabel) ? node.includedLabel : 'Included';
    if (cell.kind === 'excluded') return isProse(node.excludedLabel) ? node.excludedLabel : 'Not included';
    return isProse(cell.text) ? cell.text : '';
}

/**
 * The matrix as one <table>: a head row of column labels, then per group a
 * full-width category row and its feature rows. Cells are looked up by column
 * id, the same way the renderer does it.
 * @param {Node} node
 * @param {string[]} out
 */
function emitFeatureMatrix(node, out) {
    const columns = /** @type {unknown[]} */ (node.columns).filter(isNode);
    const groups = /** @type {unknown[]} */ (node.groups).filter(isNode)
        .map((g) => ({ title: g.title, rows: (Array.isArray(g.rows) ? g.rows : []).filter(isNode).filter((r) => isProse(r.label)) }))
        .filter((g) => g.rows.length);
    if (!columns.length || !groups.length) return;
    const head = columns.map((c) => `<th>${esc(typeof c.label === 'string' ? c.label : '')}</th>`).join('');
    const lines = [`<tr><th></th>${head}</tr>`];
    for (const g of groups) {
        if (isProse(g.title)) lines.push(`<tr><th colspan="${columns.length + 1}">${esc(g.title)}</th></tr>`);
        for (const r of g.rows) {
            const cells = Array.isArray(r.cells) ? r.cells : [];
            const tds = columns.map((c) => `<td>${esc(matrixCellText(cells.find((x) => isNode(x) && x.id === c.id), node))}</td>`);
            lines.push(`<tr><th>${esc(String(r.label))}</th>${tds.join('')}</tr>`);
        }
    }
    out.push(`<table>\n${lines.join('\n')}\n</table>`);
}

module.exports = { isFeatureMatrix, emitFeatureMatrix };
