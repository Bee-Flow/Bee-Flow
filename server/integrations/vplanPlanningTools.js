// @typecheck strict
/**
 * vPlan Tools — the three planning reads with logic of their own (resource
 * availability, board capacity, master data), as runVplanTool (vplanTools.js)
 * dispatches them. Read-only like every vPlan tool: each request is a GET.
 * Bad input throws; executeVplanTool turns that into the tool's error result.
 */

'use strict';

const { MAX_LIMIT, MASTER_DATA_TYPES, TIME_FRAMES } = require('./vplanToolDefs');
const { clampLimit, clampOffset, truncateRows, vplanRequest, vplanList } = require('./vplanClient');
const { requireUuid, requireDate, buildListQuery } = require('./vplanQuery');

/**
 * @typedef {import('./vplanTools').VplanArgs} VplanArgs
 * @typedef {import('./vplanTools').VplanCreds} VplanCreds
 * @typedef {import('./vplanTools').VplanListResult} VplanListResult
 */

// Capacity scope → path suffix under /board/{board_id}/capacity.
/** @type {Record<string, string>} */
const CAPACITY_SCOPES = {
    stage: 'stage',
    resource: 'resource',
    group: 'group',
    resource_type: 'resource_type/stage',
};

/**
 * A resource's schedule between two dates and, unless includeAbsences is
 * false, the absences that overlap the range.
 * @param {VplanArgs} args
 * @param {VplanCreds} creds
 */
async function getResourceAvailability(args, creds) {
    const id = requireUuid(args.resourceId, 'resourceId');
    const start = requireDate(args.start, 'start');
    const end = requireDate(args.end, 'end');
    const schedule = await vplanList(creds, `/resource/${id}/schedule`, {
        limit: String(clampLimit(args.limit, MAX_LIMIT)),
        offset: String(clampOffset(args.offset)),
        filter: `date:gte:'${start}',and,date:lte:'${end}'`,
        sort: 'date:asc',
    });
    /** @type {{ resourceId: string, start: string, end: string, schedule: VplanListResult, absences?: VplanListResult }} */
    const result = { resourceId: id, start, end, schedule };
    if (args.includeAbsences !== false) {
        // An absence counts when it overlaps the range at either end.
        result.absences = await vplanList(creds, `/resource/${id}/schedule_deviation`, {
            limit: String(MAX_LIMIT),
            offset: '0',
            filter: `end_date:gte:'${start}',and,start_date:lte:'${end}'`,
            sort: 'start_date:asc',
        });
    }
    return result;
}

/**
 * A board's capacity per stage, resource, group or resource type over a date
 * range, in minutes per time frame; a response too large is cut and says so.
 * @param {VplanArgs} args
 * @param {VplanCreds} creds
 */
async function getCapacity(args, creds) {
    const boardId = requireUuid(args.boardId, 'boardId');
    const scope = String(args.scope || 'stage').trim().toLowerCase();
    const suffix = CAPACITY_SCOPES[scope];
    if (!suffix) {
        throw new Error(`Invalid scope "${args.scope}". Use: ${Object.keys(CAPACITY_SCOPES).join(', ')}`);
    }
    /** @type {{ date_range_start: string; date_range_end: string; time_frame?: string; stage_id?: string }} */
    const query = {
        date_range_start: requireDate(args.dateRangeStart, 'dateRangeStart'),
        date_range_end: requireDate(args.dateRangeEnd, 'dateRangeEnd'),
    };
    if (args.timeFrame) {
        const timeFrame = String(args.timeFrame).trim().toLowerCase();
        if (!TIME_FRAMES.includes(timeFrame)) {
            throw new Error(`Invalid timeFrame "${args.timeFrame}". Use: ${TIME_FRAMES.join(', ')}`);
        }
        query.time_frame = timeFrame;
    }
    if (args.stageId && scope === 'stage') {
        query.stage_id = requireUuid(args.stageId, 'stageId');
    }
    const payload = await vplanRequest(creds, `/board/${boardId}/capacity/${suffix}`, query);
    const all = (payload && Array.isArray(payload.data)) ? payload.data : [];
    const { rows, truncated } = truncateRows(all);
    /** @type {{ boardId: string, scope: string, timeFrame: string, unit: string, data: unknown[], truncated?: boolean, message?: string }} */
    const result = { boardId, scope, timeFrame: query.time_frame || 'day', unit: 'minutes', data: rows };
    if (truncated) {
        result.truncated = true;
        result.message = `Response too large — showing ${rows.length} of ${all.length} buckets. Narrow the date range or use a larger timeFrame.`;
    }
    return result;
}

/**
 * One kind of master data (MASTER_DATA_TYPES): one record by id, or a page of
 * them.
 * @param {VplanArgs} args
 * @param {VplanCreds} creds
 */
async function listMasterData(args, creds) {
    const type = String(args.type || '').trim().toLowerCase();
    const spec = /** @type {Record<string, { path: string, withKey?: string, supportsArchived?: boolean }>} */ (MASTER_DATA_TYPES)[type];
    if (!spec) {
        throw new Error(`Invalid type "${args.type}". Use: ${Object.keys(MASTER_DATA_TYPES).join(', ')}`);
    }
    if (args.id) {
        const id = requireUuid(args.id, 'id');
        return { type, record: await vplanRequest(creds, `${spec.path}/${id}`) };
    }
    /** @type {Record<string, string>} */
    const query = buildListQuery(args, spec.withKey || null);
    if (spec.supportsArchived && args.archived === true) query.archived = 'true';
    /** @type {VplanListResult} */
    const result = await vplanList(creds, spec.path, query);
    result.type = type;
    return result;
}

module.exports = { getResourceAvailability, getCapacity, listMasterData, CAPACITY_SCOPES };
