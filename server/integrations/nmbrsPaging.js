// @typecheck strict
'use strict';

// Result shaping for the NMBRS tools: the size cap and server-side paging.
// The SOAP calls return everything at once, so a large employer is paged over
// the parsed array. A page is always cut to fit MAX_RESPONSE_CHARS; the cap
// stays as the safety net behind it (truncateRows).

const MAX_RESPONSE_CHARS = 30000;
const DEFAULT_PAGE_SIZE = 100;
const MAX_PAGE_SIZE = 500;

const PAGING_PROPS = {
    offset: { type: 'integer', description: 'Paging: number of records to skip. Start at 0 and pass nextOffset from the previous result while hasMore is true.' },
    limit: { type: 'integer', description: `Paging: records per page (default ${DEFAULT_PAGE_SIZE}, max ${MAX_PAGE_SIZE}). A page is also cut to stay under the response size limit.` }
};

/**
 * Drop trailing rows until the serialized result fits the LLM-context budget.
 * Never truncates mid-row. (Mirrors afasTools.truncateRows.)
 * @param {unknown} rows
 * @param {number} [maxChars]
 * @returns {{ rows: any[], truncated: boolean }}
 */
function truncateRows(rows, maxChars = MAX_RESPONSE_CHARS) {
    if (!Array.isArray(rows)) return { rows: [], truncated: false };
    let kept = rows;
    let truncated = false;
    while (kept.length > 1 && JSON.stringify(kept).length > maxChars) {
        kept = kept.slice(0, Math.floor(kept.length / 2));
        truncated = true;
    }
    if (kept.length > 0 && JSON.stringify(kept).length > maxChars) {
        kept = [];
        truncated = true;
    }
    return { rows: kept, truncated };
}

/**
 * @param {unknown} rawRows
 * @param {string} [scope]
 */
function shapeList(rawRows, scope) {
    const arr = Array.isArray(rawRows) ? rawRows : [];
    const { rows, truncated } = truncateRows(arr);
    /** @type {Record<string, unknown>} */
    const result = { items: rows, count: rows.length };
    if (truncated) {
        result.truncated = true;
        result.message = `Response too large — showing ${rows.length} of ${arr.length} ${scope || 'records'}. Narrow by company, employee or period.`;
    }
    return result;
}

/**
 * Read `offset` / `limit` from tool args. Both optional.
 * @param {Record<string, unknown>} args
 * @returns {{ offset: number, limit: number } | { error: string }}
 */
function parsePaging(args) {
    const rawOffset = args.offset;
    const rawLimit = args.limit;
    let offset = 0;
    let limit = DEFAULT_PAGE_SIZE;
    if (rawOffset !== undefined && rawOffset !== null && rawOffset !== '') {
        offset = Number(rawOffset);
        if (!Number.isInteger(offset) || offset < 0) return { error: 'Invalid offset. Use a whole number of 0 or more (nextOffset from the previous page).' };
    }
    if (rawLimit !== undefined && rawLimit !== null && rawLimit !== '') {
        limit = Number(rawLimit);
        if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE) return { error: `Invalid limit. Use a whole number from 1 to ${MAX_PAGE_SIZE}.` };
    }
    return { offset, limit };
}

/**
 * One page of `rows`: at most `limit` rows from `offset`, further cut so the
 * page serializes under `maxChars`. `nextOffset` is where the next call starts
 * (null when everything has been read).
 * @param {unknown} rawRows
 * @param {{ offset: number, limit: number }} paging
 * @param {string} scope
 * @param {number} [maxChars]
 */
function shapePage(rawRows, paging, scope, maxChars = MAX_RESPONSE_CHARS) {
    const all = Array.isArray(rawRows) ? rawRows : [];
    const { offset, limit } = paging;
    const window = all.slice(offset, offset + limit);
    /** @type {any[]} */
    const fitted = [];
    let size = 2;
    for (const row of window) {
        const rowSize = JSON.stringify(row).length + 1;
        if (size + rowSize > maxChars) break;
        fitted.push(row);
        size += rowSize;
    }
    // Safety net: the cap applies whatever the arithmetic above says.
    const { rows } = truncateRows(fitted, maxChars);
    /** @type {Record<string, unknown>} */
    const result = { items: rows, count: rows.length, total: all.length, offset };
    let consumed = rows.length;
    if (rows.length === 0 && window.length > 0) {
        // A single record larger than the cap: skip it rather than loop forever.
        consumed = 1;
        result.truncated = true;
        result.message = `The ${scope} record at offset ${offset} is larger than the response limit and was skipped. Continue with nextOffset.`;
    } else if (rows.length < window.length) {
        result.truncated = true;
        result.message = `Page cut to ${rows.length} ${scope} to stay under the response limit. Continue with nextOffset.`;
    }
    const next = offset + consumed;
    result.hasMore = next < all.length;
    result.nextOffset = result.hasMore ? next : null;
    return result;
}

module.exports = { MAX_RESPONSE_CHARS, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE, PAGING_PROPS, truncateRows, shapeList, parsePaging, shapePage };
