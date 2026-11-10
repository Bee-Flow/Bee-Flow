// @typecheck strict
/**
 * The list query of a table page: filter, sort, orderBy, match, search, expand and fields from
 * the query string. Shared by the signed-in records route (appDataRecords.js) and the public one
 * (studioAppPublic.js); appDataContext.js re-exports both functions.
 */

'use strict';

const { fallback } = require('../../utils/bestEffort');
const { relationQueryOf } = require('./appRuntimeSchemas');

// Parse list filters/sort from the query string (JSON-encoded). Bad JSON is
// ignored rather than 400 — the compiler validates the resulting shapes.
/** @param {import('express').Request} req */
function parseListQuery(req) {
    const q = req.query || {};
    let filters;
    let sort;
    if (typeof q.filter === 'string' && q.filter) { try { filters = JSON.parse(q.filter); } catch (err) { fallback('routes/studio/appDataContext:parseListQuery', err); /* ignore */ } }
    if (typeof q.sort === 'string' && q.sort) { try { sort = JSON.parse(q.sort); } catch (err) { fallback('routes/studio/appDataContext:parseListQuery#2', err); /* ignore */ } }
    if (filters !== undefined && !Array.isArray(filters)) filters = [filters];
    /** @type {unknown} */
    let orderBy;
    if (typeof q.orderBy === 'string' && q.orderBy) { try { orderBy = JSON.parse(q.orderBy); } catch (err) { fallback('routes/studio/appDataContext:parseListQuery#3', err); /* ignore */ } }
    return { ...(orderBy === undefined ? { filters, sort } : { filters, sort, orderBy }), ...optionalListQuery(q), ...relationQueryOf(q) };
}

/**
 * The query fields that exist only when the request sends them: how the filters join and a free
 * search. Absent means absent, so a request without them compiles exactly as it always did.
 * @param {import('qs').ParsedQs} q
 */
function optionalListQuery(q) {
    /** @type {{ match?: string, search?: unknown }} */
    const out = {};
    if (typeof q.match === 'string' && q.match) out.match = q.match;
    if (typeof q.search === 'string' && q.search) { try { out.search = JSON.parse(q.search); } catch (err) { fallback('routes/studio/appDataContext:optionalListQuery', err); /* the compiler validates */ } }
    return out;
}

module.exports = { parseListQuery, optionalListQuery };
