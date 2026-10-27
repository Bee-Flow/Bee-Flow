// @typecheck
const DEFAULT_LIMIT = 25;

// vPlan allows up to 1000, but a large page blows the model's context budget and
// is the documented cause of vPlan's own "memory exhausted" (10005) error.
const MAX_LIMIT = 100;

// Allowed first-layer `with` (eager loading) values per endpoint. Anything the
// model invents is dropped rather than forwarded, so a typo never 400s the call.
const WITH_OPTIONS = {
    board: ['stages', 'collections', 'cards'],
    activity: ['time_tracking', 'stages'],
    resource: ['activities', 'cards', 'resources', 'schedules'],
    collection: ['activities', 'attachments', 'cards', 'checklists', 'comments', 'followers', 'labels', 'order'],
    // `statuses` is listed in vPlan's own docs for the card endpoint but the live
    // API rejects it with "Relation not found: statuses" — dropped deliberately.
    // The status is already on the card as `status_id`, and the readable status
    // objects come with the board (vplan_list_boards).
    card: ['activities', 'collection', 'labels', 'resources', 'stage', 'time', 'time_tracking', 'relations'],
    order: ['orderRows', 'item', 'relation'],
    group: ['resources'],
    user: ['resource', 'time_tracking', 'settings', 'board_views'],
    space: ['boards'],
};

// Master-data endpoints that are thin enough to share one tool.
const MASTER_DATA_TYPES = {
    project:   { path: '/project' },
    item:      { path: '/item' },
    relation:  { path: '/relation' },
    warehouse: { path: '/warehouse' },
    user:      { path: '/user',  withKey: 'user',  supportsArchived: true },
    group:     { path: '/group', withKey: 'group' },
    space:     { path: '/space', withKey: 'space' },
};

const TIME_FRAMES = ['day', 'week', 'month', 'quarter', 'year'];

const TIME_TRACKING_GROUP_BY = [
    'days', 'weeks', 'activities', 'collections', 'boards', 'statuses', 'users',
];

const FILTER_PARAM = {
    type: 'array',
    description: 'Optional filters, combined with AND. Use snake_case field names from the objects this tool returns (e.g. start_date, status, updated_at). Dates are YYYY-MM-DD, timestamps ISO-8601.',
    items: {
        type: 'object',
        properties: {
            field: { type: 'string', description: 'Field to filter on' },
            operator: { type: 'string', description: 'One of: eq, not, gt, gte, lt, lte, has, contains, starts_with, ends_with (default: eq)' },
            value: { type: 'string', description: 'Value to compare against. May not contain a single quote.' },
        },
        required: ['field', 'value'],
    },
};

const SORT_PARAM = {
    type: 'array',
    description: 'Optional sort order. Only works on main fields of the object, not on eager-loaded ones.',
    items: {
        type: 'object',
        properties: {
            field: { type: 'string', description: 'Field to sort on' },
            direction: { type: 'string', description: '"asc" (default) or "desc"' },
        },
        required: ['field'],
    },
};

/**
 * Build the shared parameter schema for a list tool: pagination + filter + sort,
 * plus an optional `with` enum and any tool-specific extras.
 */
function listParams(withKey, extra = {}, required = []) {
    /** @type {Record<string, any>} */ const properties = {
        limit: { type: 'integer', description: `Maximum number of records (1-${MAX_LIMIT}, default ${DEFAULT_LIMIT})` },
        offset: { type: 'integer', description: 'Pagination offset (default 0)' },
        filters: FILTER_PARAM,
        sort: SORT_PARAM,
        ...extra,
    };
    if (withKey && WITH_OPTIONS[withKey]) {
        properties.with = {
            type: 'array',
            description: 'Related objects to include in the response. Only request what you need — large payloads get truncated.',
            items: { type: 'string', enum: WITH_OPTIONS[withKey] },
        };
    }
    return { type: 'object', properties, required };
}

function fn(name, description, parameters) {
    return { type: 'function', function: { name, description, parameters } };
}

const VPLAN_TOOLS = [
    fn(
        'vplan_whoami',
        'Show which vPlan environment the current API key is connected to: customer name, environment status, enabled features and permissions. Use this to confirm the connection works or to tell the user which vPlan account is linked.',
        { type: 'object', properties: {}, required: [] },
    ),
    fn(
        'vplan_list_boards',
        'List the vPlan planning boards. ALWAYS call this first when you need to work with cards, stages, statuses, labels or capacity — the board object carries the stage IDs, status IDs, label IDs and custom-field definitions that the other vPlan tools need. Never guess these IDs.',
        listParams('board', {
            boardId: { type: 'string', description: 'Optional: fetch one board by id instead of the list' },
        }),
    ),
    fn(
        'vplan_list_resources',
        'List the vPlan resources — the plannable employees, machines and cells, with their working hours per weekday. Use this to find resource IDs before asking for availability or capacity.',
        listParams('resource', {
            resourceId: { type: 'string', description: 'Optional: fetch one resource by id instead of the list' },
            archived: { type: 'boolean', description: 'Include archived resources (default false)' },
        }),
    ),
    fn(
        'vplan_get_resource_availability',
        'Get the day-by-day schedule of one vPlan resource over a date range: hours available, hours of planned work, hours of leave and hours of absence — plus the absences (leave, holiday, maintenance, malfunction, …) that overlap the range. Use this to answer "who is available when".',
        {
            type: 'object',
            properties: {
                resourceId: { type: 'string', description: 'Resource id from vplan_list_resources' },
                start: { type: 'string', description: 'Start of the range, YYYY-MM-DD' },
                end: { type: 'string', description: 'End of the range, YYYY-MM-DD' },
                includeAbsences: { type: 'boolean', description: 'Also return the absences overlapping the range (default true)' },
                limit: { type: 'integer', description: `Maximum number of days (1-${MAX_LIMIT}, default ${MAX_LIMIT})` },
                offset: { type: 'integer', description: 'Pagination offset (default 0)' },
            },
            required: ['resourceId', 'start', 'end'],
        },
    ),
    fn(
        'vplan_list_activities',
        'List the vPlan activities — the services or operations that can be planned (with their resource type, default duration, billable flag and hourly rate). Activity IDs are needed to read time tracking per activity.',
        listParams('activity', {
            activityId: { type: 'string', description: 'Optional: fetch one activity by id instead of the list' },
        }),
    ),
    fn(
        'vplan_list_collections',
        'List vPlan collections — the jobs, orders or projects that are planned (or waiting in the backlog). Each collection holds one or more cards once planned. Filter on status (planned/not_planned/ignored), progress (open/partial/done), due_date, board_id or updated_at.',
        listParams('collection', {
            boardId: { type: 'string', description: 'Optional: only collections on this board' },
        }),
    ),
    fn(
        'vplan_get_collection',
        'Get one vPlan collection in full, optionally with its cards, attachments, comments and checklists. Use this when the user asks about a specific job/order and you need the detail rather than a list.',
        {
            type: 'object',
            properties: {
                collectionId: { type: 'string', description: 'Collection id from vplan_list_collections' },
                include: {
                    type: 'array',
                    description: 'Extra detail to fetch alongside the collection.',
                    items: { type: 'string', enum: ['cards', 'attachments', 'comments', 'checklists'] },
                },
            },
            required: ['collectionId'],
        },
    ),
    fn(
        'vplan_list_cards',
        'List vPlan cards — the actual planned work items with their start/end date and time, stage, status and assigned resources. This is the main tool for "what is planned this week", "what is on this board" and "what is this person working on". Filter on start_date / end_date / stage_id / status_id / collection_id.',
        listParams('card', {
            collectionId: { type: 'string', description: 'Optional: only the cards of this collection. Note: an unknown collection id returns an empty list, not an error.' },
            enrichCustomFields: { type: 'boolean', description: 'Resolve custom-field values to their labels (default false)' },
        }),
    ),
    fn(
        'vplan_get_card',
        'Get one vPlan card in full: dates, stage, status, assigned resources, activities, labels, time tracking, and optionally its checklists and its relations to other cards (blocks / depends / related / cloned).',
        {
            type: 'object',
            properties: {
                collectionId: { type: 'string', description: 'Collection id the card belongs to' },
                cardId: { type: 'string', description: 'Card id from vplan_list_cards' },
                with: {
                    type: 'array',
                    description: 'Related objects to include on the card itself.',
                    items: { type: 'string', enum: WITH_OPTIONS.card },
                },
                includeChecklists: { type: 'boolean', description: 'Also fetch the checklists of this card (default true)' },
                includeRelations: { type: 'boolean', description: 'Also fetch the relations to other cards (default false)' },
            },
            required: ['collectionId', 'cardId'],
        },
    ),
    fn(
        'vplan_list_orders',
        'List vPlan orders — the sales, production, purchase, quotation or project orders pushed into vPlan from the source system, with their dates, status, quantity and links to relation/item/project/warehouse.',
        listParams('order', {
            orderId: { type: 'string', description: 'Optional: fetch one order by id instead of the list' },
        }),
    ),
    fn(
        'vplan_get_order',
        'Get one vPlan order together with its order rows (line items with quantities, units, delivered/backorder amounts and the activity each row maps to).',
        {
            type: 'object',
            properties: {
                orderId: { type: 'string', description: 'Order id from vplan_list_orders' },
                limit: { type: 'integer', description: `Maximum number of order rows (1-${MAX_LIMIT}, default ${MAX_LIMIT})` },
                offset: { type: 'integer', description: 'Pagination offset for the order rows (default 0)' },
            },
            required: ['orderId'],
        },
    ),
    fn(
        'vplan_list_time_tracking',
        'List individual vPlan time-tracking entries: start, end, duration in minutes, approval status, note, and the card / activity / user each entry belongs to. Filter on start, user_id, card_id, activity_id or status. For totals rather than entries, use vplan_time_tracking_summary.',
        listParams(null, {}),
    ),
    fn(
        'vplan_time_tracking_summary',
        'Get aggregated vPlan time tracking over a period, grouped by days, weeks, activities, collections, boards, statuses or users. Use this for "how many hours did we spend on X last month" instead of listing every entry.',
        {
            type: 'object',
            properties: {
                groupBy: { type: 'string', description: `How to aggregate. One of: ${TIME_TRACKING_GROUP_BY.join(', ')}` },
                start: { type: 'string', description: 'Start of the period, YYYY-MM-DD' },
                end: { type: 'string', description: 'End of the period, YYYY-MM-DD' },
            },
            required: [],
        },
    ),
    fn(
        'vplan_get_capacity',
        'Get planned versus available capacity for a vPlan board over a date range, broken down per stage, per resource, per group, or per resource type within each stage. Times are in minutes. Use this to answer "are we overbooked" and "where is the bottleneck".',
        {
            type: 'object',
            properties: {
                boardId: { type: 'string', description: 'Board id from vplan_list_boards' },
                scope: { type: 'string', description: 'Breakdown to return. One of: stage, resource, group, resource_type (default: stage)' },
                dateRangeStart: { type: 'string', description: 'Start of the range, YYYY-MM-DD' },
                dateRangeEnd: { type: 'string', description: 'End of the range, YYYY-MM-DD' },
                timeFrame: { type: 'string', description: `Bucket size. One of: ${TIME_FRAMES.join(', ')} (default: day)` },
                stageId: { type: 'string', description: 'Optional, scope "stage" only: limit to one stage' },
            },
            required: ['boardId', 'dateRangeStart', 'dateRangeEnd'],
        },
    ),
    fn(
        'vplan_list_master_data',
        'List one of the vPlan master-data sets: projects, items (products), relations (customers/vendors), warehouses, users, groups or spaces. Use this to resolve the IDs referenced by orders, cards and collections into readable names.',
        listParams(null, {
            type: { type: 'string', description: `Which master-data set to list. One of: ${Object.keys(MASTER_DATA_TYPES).join(', ')}` },
            id: { type: 'string', description: 'Optional: fetch one record by id instead of the list' },
            archived: { type: 'boolean', description: 'Include archived records — only applies to type "user" (default false)' },
        }, ['type']),
    ),
];

const VPLAN_TOOL_NAMES = new Set(VPLAN_TOOLS.map(t => t.function.name));

module.exports = { DEFAULT_LIMIT, MAX_LIMIT, WITH_OPTIONS, MASTER_DATA_TYPES, TIME_FRAMES, TIME_TRACKING_GROUP_BY, VPLAN_TOOLS, VPLAN_TOOL_NAMES };
