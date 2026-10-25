/**
 * vPlan Tools — read-only access to a vPlan planning environment.
 *
 * vPlan (app.vplan.com) is a planning/work-preparation platform: boards with
 * stages, collections (jobs) that get planned into cards, resources with
 * schedules, orders, and time tracking. This module exposes GET endpoints only —
 * every request is a GET and the tool set contains no create/update/delete
 * operations by design (vplanTools.test.js asserts both).
 *
 * Auth is a per-user API key pair (X-Api-Key + X-Api-Env), both copied from
 * vPlan → Settings → Developers → API keys. The base URL is a fixed constant,
 * so unlike AFAS/YouTrack there is no user-controlled host and no SSRF surface;
 * the only injection vector is CR/LF into the two headers, which the credential
 * regexes below reject.
 *
 * The request helper is local rather than shared/apiClient.jsonApiRequest for
 * two reasons the shared helper cannot express:
 *   - vPlan answers HTTP 303 with a redirect to an HTML maintenance page, and
 *     the API docs say explicitly not to follow it (following it hands the model
 *     a 200 full of HTML instead of JSON) — so every fetch uses redirect:'manual'.
 *   - The RateLimit-* response headers drive the single 429 retry.
 * Uses raw REST — no npm dependencies.
 *
 * API reference: https://docs.api.vplan.com/
 */
// @typecheck
const configStore = require('../stores/configStore');
const log = require('../telemetry/log');
const { MAX_LIMIT, WITH_OPTIONS, MASTER_DATA_TYPES, TIME_FRAMES, TIME_TRACKING_GROUP_BY, VPLAN_TOOLS, VPLAN_TOOL_NAMES } = require('./vplanToolDefs');
const { clampLimit, clampOffset, truncateRows, stripNoise, extractVplanErrorMessage, retryDelayMs, buildUrl, vplanRequest, vplanList } = require('./vplanClient');
const { buildFilterParams, buildSortParam, buildWithParam, requireUuid, requireDate, buildListQuery } = require('./vplanQuery');

// Both credentials travel in request headers, so these regexes are the
// header-injection guard: no whitespace, no CR, no LF.
const API_KEY_RE = /^[A-Za-z0-9._~-]{16,512}$/;
const API_ENV_RE = /^[A-Za-z0-9._~-]{4,128}$/;

// Capacity scope → path suffix under /board/{board_id}/capacity.
const CAPACITY_SCOPES = {
    stage: 'stage',
    resource: 'resource',
    group: 'group',
    resource_type: 'resource_type/stage',
};

// ─── Tool definitions (OpenAI function-calling format) ─────────

// ─── Pure helpers (exported for tests) ─────────────────────────

// ─── API client ────────────────────────────────────────────────

// ─── Credentials ───────────────────────────────────────────────

async function getVplanCredentials(userId) {
    const apiKey = await configStore.getSecret(`vplan_api_key_user_${userId}`);
    const apiEnv = await configStore.getSecret(`vplan_api_env_user_${userId}`);
    if (!apiKey || !apiEnv) return null;
    return { apiKey: String(apiKey).trim(), apiEnv: String(apiEnv).trim() };
}

/**
 * Re-validate the stored credentials before they reach a request header. The
 * save path validates too, but a value written by an older build (or restored
 * from a backup) must never be able to inject a header.
 */
function assertValidCredentials(creds) {
    if (!API_KEY_RE.test(creds.apiKey)) {
        throw new Error('The stored vPlan API key has an invalid format. Re-enter it in Settings → Connections.');
    }
    if (!API_ENV_RE.test(creds.apiEnv)) {
        throw new Error('The stored vPlan environment has an invalid format. Re-enter it in Settings → Connections.');
    }
}

// ─── Tool execution ────────────────────────────────────────────

async function runVplanTool(toolName, args, creds) {
    switch (toolName) {
        case 'vplan_whoami': {
            const me = await vplanRequest(creds, '/me');
            return {
                type: me?.type || null,
                environment: me?.environment || null,
                organizations: me?.organizations || null,
                user: me?.user || null,
                features: me?.features || null,
                permissions: me?.permissions || null,
            };
        }

        case 'vplan_list_boards': {
            if (args.boardId) {
                const id = requireUuid(args.boardId, 'boardId');
                return { board: await vplanRequest(creds, `/board/${id}`) };
            }
            return vplanList(creds, '/board', buildListQuery(args, 'board'));
        }

        case 'vplan_list_resources': {
            if (args.resourceId) {
                const id = requireUuid(args.resourceId, 'resourceId');
                return { resource: await vplanRequest(creds, `/resource/${id}`) };
            }
            const query = buildListQuery(args, 'resource');
            if (args.archived === true) query.archived = 'true';
            return vplanList(creds, '/resource', query);
        }

        case 'vplan_get_resource_availability': {
            const id = requireUuid(args.resourceId, 'resourceId');
            const start = requireDate(args.start, 'start');
            const end = requireDate(args.end, 'end');
            const schedule = await vplanList(creds, `/resource/${id}/schedule`, {
                limit: String(clampLimit(args.limit, MAX_LIMIT)),
                offset: String(clampOffset(args.offset)),
                filter: `date:gte:'${start}',and,date:lte:'${end}'`,
                sort: 'date:asc',
            });
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

        case 'vplan_list_activities': {
            if (args.activityId) {
                const id = requireUuid(args.activityId, 'activityId');
                return { activity: await vplanRequest(creds, `/activity/${id}`) };
            }
            return vplanList(creds, '/activity', buildListQuery(args, 'activity'));
        }

        case 'vplan_list_collections': {
            const query = buildListQuery(args, 'collection');
            if (args.boardId) {
                const boardId = requireUuid(args.boardId, 'boardId');
                const scoped = `board_id:eq:'${boardId}'`;
                query.filter = query.filter ? `${query.filter},and,${scoped}` : scoped;
            }
            return vplanList(creds, '/collection', query);
        }

        case 'vplan_get_collection': {
            const id = requireUuid(args.collectionId, 'collectionId');
            const result = { collection: await vplanRequest(creds, `/collection/${id}`) };
            const include = Array.isArray(args.include) ? args.include : [];
            // Fetched as separate documented sub-resources rather than via `with`,
            // which the single-collection endpoint does not document.
            const pageQuery = { limit: String(MAX_LIMIT), offset: '0' };
            if (include.includes('cards')) {
                result.cards = await vplanList(creds, `/collection/${id}/card`, pageQuery);
            }
            if (include.includes('attachments')) {
                result.attachments = await vplanList(creds, `/collection/${id}/attachment`, pageQuery);
            }
            if (include.includes('comments')) {
                result.comments = await vplanList(creds, `/collection/${id}/comment`, pageQuery);
            }
            if (include.includes('checklists')) {
                result.checklists = await vplanList(creds, `/collection/${id}/checklist`, pageQuery);
            }
            return result;
        }

        case 'vplan_list_cards': {
            const query = buildListQuery(args, 'card');
            if (args.enrichCustomFields === true) query.enrich_custom_fields = 'true';
            if (args.collectionId) {
                const id = requireUuid(args.collectionId, 'collectionId');
                const result = await vplanList(creds, `/collection/${id}/card`, query);
                if (result.count === 0) {
                    result.message = 'No cards returned. Note that vPlan answers with an empty list — not an error — when the collection id does not exist.';
                }
                return result;
            }
            return vplanList(creds, '/card', query);
        }

        case 'vplan_get_card': {
            const collectionId = requireUuid(args.collectionId, 'collectionId');
            const cardId = requireUuid(args.cardId, 'cardId');
            const query = {};
            const withParam = buildWithParam(args.with, 'card');
            if (withParam) query.with = withParam;
            const result = { card: await vplanRequest(creds, `/collection/${collectionId}/card/${cardId}`, query) };
            if (args.includeChecklists !== false) {
                result.checklists = await vplanList(creds, `/collection/${collectionId}/card/${cardId}/checklist`, { limit: String(MAX_LIMIT), offset: '0' });
            }
            if (args.includeRelations === true) {
                result.relations = await vplanList(creds, '/card_relation', {
                    limit: String(MAX_LIMIT),
                    offset: '0',
                    filter: `card_id:eq:'${cardId}'`,
                });
            }
            return result;
        }

        case 'vplan_list_orders': {
            if (args.orderId) {
                const id = requireUuid(args.orderId, 'orderId');
                return { order: await vplanRequest(creds, `/order/${id}`) };
            }
            return vplanList(creds, '/order', buildListQuery(args, 'order'));
        }

        case 'vplan_get_order': {
            const id = requireUuid(args.orderId, 'orderId');
            const order = await vplanRequest(creds, `/order/${id}`);
            const rows = await vplanList(creds, `/order/${id}/row`, {
                limit: String(clampLimit(args.limit, MAX_LIMIT)),
                offset: String(clampOffset(args.offset)),
            });
            return { order, rows };
        }

        case 'vplan_list_time_tracking':
            return vplanList(creds, '/time_tracking', buildListQuery(args, null));

        case 'vplan_time_tracking_summary': {
            const query = {};
            if (args.groupBy) {
                const groupBy = String(args.groupBy).trim().toLowerCase();
                if (!TIME_TRACKING_GROUP_BY.includes(groupBy)) {
                    throw new Error(`Invalid groupBy "${args.groupBy}". Use: ${TIME_TRACKING_GROUP_BY.join(', ')}`);
                }
                query.group_by = groupBy;
            }
            if (args.start) query.start = requireDate(args.start, 'start');
            if (args.end) query.end = requireDate(args.end, 'end');
            return { summary: await vplanRequest(creds, '/time_tracking/export', query) };
        }

        case 'vplan_get_capacity': {
            const boardId = requireUuid(args.boardId, 'boardId');
            const scope = String(args.scope || 'stage').trim().toLowerCase();
            const suffix = CAPACITY_SCOPES[scope];
            if (!suffix) {
                throw new Error(`Invalid scope "${args.scope}". Use: ${Object.keys(CAPACITY_SCOPES).join(', ')}`);
            }
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
            const result = { boardId, scope, timeFrame: query.time_frame || 'day', unit: 'minutes', data: rows };
            if (truncated) {
                result.truncated = true;
                result.message = `Response too large — showing ${rows.length} of ${all.length} buckets. Narrow the date range or use a larger timeFrame.`;
            }
            return result;
        }

        case 'vplan_list_master_data': {
            const type = String(args.type || '').trim().toLowerCase();
            const spec = MASTER_DATA_TYPES[type];
            if (!spec) {
                throw new Error(`Invalid type "${args.type}". Use: ${Object.keys(MASTER_DATA_TYPES).join(', ')}`);
            }
            if (args.id) {
                const id = requireUuid(args.id, 'id');
                return { type, record: await vplanRequest(creds, `${spec.path}/${id}`) };
            }
            const query = buildListQuery(args, spec.withKey || null);
            if (spec.supportsArchived && args.archived === true) query.archived = 'true';
            const result = await vplanList(creds, spec.path, query);
            result.type = type;
            return result;
        }

        default:
            throw new Error(`Unknown vPlan tool: ${toolName}`);
    }
}

async function executeVplanTool(toolName, args, userId) {
    if (!userId) return { error: 'User context required for vPlan.' };
    if (!isVplanTool(toolName)) return { error: `Unknown vPlan tool: ${toolName}` };

    const creds = await getVplanCredentials(userId);
    if (!creds) {
        return { error: 'vPlan not configured. Add your API key and environment in Settings → Connections.' };
    }

    try {
        assertValidCredentials(creds);
        log.info(`[vPlan] ${toolName}`);
        return await runVplanTool(toolName, args || {}, creds);
    } catch (err) {
        log.warn(`[vPlan] ${toolName} failed: ${err.message}`);
        return { error: `vPlan: ${err.message}` };
    }
}

function isVplanTool(toolName) {
    return VPLAN_TOOL_NAMES.has(toolName);
}

module.exports = {
    VPLAN_TOOLS,
    executeVplanTool,
    isVplanTool,
    // Shape checks reused by the settings save path.
    API_KEY_RE,
    API_ENV_RE,
    // Pure helpers exported for unit tests.
    buildFilterParams,
    buildSortParam,
    buildWithParam,
    buildUrl,
    buildListQuery,
    clampLimit,
    clampOffset,
    truncateRows,
    stripNoise,
    extractVplanErrorMessage,
    retryDelayMs,
    WITH_OPTIONS,
    MAX_LIMIT,
};

/** @typedef {{ apiKey: string, apiEnv: string }} VplanCreds */

/** A parsed vPlan JSON response body. @typedef {{ data?: unknown[], count?: number, [key: string]: unknown }} VplanPayload */

/**
 * @typedef {{ data: unknown[], count: number, offset: number, limit: number, total?: number,
 *   hasMore?: boolean, truncated?: boolean, message?: string, type?: string }} VplanListResult
 */

/**
 * The tool arguments as the model sends them.
 * @typedef {{
 *   boardId?: string, resourceId?: string, activityId?: string, collectionId?: string, cardId?: string,
 *   orderId?: string, stageId?: string, id?: string, type?: string, scope?: string, groupBy?: string,
 *   timeFrame?: string, start?: string, end?: string, dateRangeStart?: string, dateRangeEnd?: string,
 *   limit?: unknown, offset?: unknown, filters?: unknown, sort?: unknown, with?: unknown, include?: unknown,
 *   archived?: boolean, includeAbsences?: boolean, enrichCustomFields?: boolean,
 *   includeChecklists?: boolean, includeRelations?: boolean,
 * }} VplanArgs
 */
