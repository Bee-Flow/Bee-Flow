/**
 * Google Sheets. No hand-written poller and no Google push channel — both
 * events come from the generic poll_diff runtime, which is the point of
 * declaration-driven triggers: a connected app becomes a trigger source
 * without new platform code.
 *
 * "Spreadsheet edited" has two modes, picked by the subscription's filter:
 *
 *   - No spreadsheetId: diff what sheets_list returns — the file's
 *     modifiedTime moved, which is what Drive reports the moment anyone
 *     edits it. This is the wide net.
 *   - spreadsheetId set (optionally with sheet + range): the contentWatch
 *     variant polls sheets_get_values for THAT sheet and diffs row by row,
 *     so the trigger fires on actual content changes inside the watched
 *     range — a new row, a changed cell — instead of any touch of any file.
 *     The row's position is its identity ('$index'): inserting a row at the
 *     top shifts every row below it, which reads as edits, not one insert.
 *
 * The UI controls for the filter live in the builder's per-(provider, event)
 * filter form (FILTER_FORM_BY_KEY in triggerFilters.jsx) — the same pattern
 * every other declared source with config follows; `configFields` below keeps
 * the declaration itself honest about which filter keys mean something, and
 * is what triggerFilters.jsx and the matcher (triggerBus/filters.js
 * matchSheetsChangedFilter) are written against.
 */

const FILE_FIELDS = ['id', 'name', 'url', 'modifiedTime', 'changedKeys', 'previous', 'current', 'changedAt'];
// Union of the two payload modes: the file-level keys plus the row-watch keys.
const CHANGED_FIELDS = [...FILE_FIELDS, 'spreadsheetId', 'sheet', 'range', 'rowIndex', 'row'];

const FILE_SAMPLE = {
    id: '1AbCDeFgHiJkLmNoPqRsTuV',
    name: 'Invoice tracker 2026',
    url: 'https://docs.google.com/spreadsheets/d/1AbCDeFgHiJkLmNoPqRsTuV/edit',
    modifiedTime: '2026-05-12T10:23:00Z',
    changedKeys: ['modifiedTime'],
    previous: { modifiedTime: '2026-05-11T09:02:00Z' },
    current: { modifiedTime: '2026-05-12T10:23:00Z' },
    changedAt: '2026-05-12T10:23:04.881Z',
};

const CHANGED_SAMPLE = {
    ...FILE_SAMPLE,
    spreadsheetId: '1AbCDeFgHiJkLmNoPqRsTuV',
    sheet: 'Invoices',
    range: 'A1:D100',
    rowIndex: 7,
    row: ['2026-05-12', 'Acme BV', '1200.00', 'paid'],
};

/**
 * 'Budget'!A1:D — the sheet goes in single quotes (a name can hold spaces),
 * with a quote inside it doubled, per the Sheets A1-notation rules. No range
 * means the whole tab, and sheets_get_values already defaults to the first
 * tab when neither is set.
 */
function composeRange(filter) {
    const sheet = typeof filter?.sheet === 'string' ? filter.sheet.trim() : '';
    const range = typeof filter?.range === 'string' ? filter.range.trim() : '';
    if (sheet && range) return `'${sheet.replace(/'/g, "''")}'!${range}`;
    return range || sheet || undefined;
}

const CONFIG_FIELDS = [
    {
        key: 'spreadsheetId',
        label: 'Spreadsheet',
        hint: 'From the sheet URL: docs.google.com/spreadsheets/d/<id>/edit. Set this to watch the sheet\'s contents row by row instead of the file\'s edit time.',
    },
    {
        key: 'sheet',
        label: 'Sheet / tab',
        hint: 'Tab name, e.g. Budget. Default: the first tab.',
    },
    {
        key: 'range',
        label: 'Range',
        hint: 'A1 notation, e.g. A1:D100 or C:C to watch one column. Default: the whole tab.',
    },
];

const source = (over = {}) => ({
    kind: 'poll_diff',
    tool: 'sheets_list',
    args: { pageSize: 100 },
    requiresIntegration: 'google-sheets',
    itemsPath: 'results',
    idPath: 'id',
    changePaths: ['modifiedTime'],
    firstRun: 'anchor',
    minIntervalMs: 300_000,
    cacheTtlMs: 15_000,
    maxItemsPerTick: 25,
    maxTrackedItems: 100,
    trackValues: true,
    emit: {
        mode: 'item',
        map: { id: 'id', name: 'name', url: 'url', modifiedTime: 'modifiedTime' },
        includeChanges: true,
    },
    ...over,
});

const TRIGGER_SOURCES = [{
    id: 'google-sheets',
    label: 'Google Sheets',
    order: 31,
    defaultEvent: 'spreadsheet.changed',
    availability: { kind: 'tools', apps: ['google-sheets'] },
    events: [
        {
            id: 'spreadsheet.changed',
            label: 'Spreadsheet edited',
            fields: CHANGED_FIELDS,
            sample: CHANGED_SAMPLE,
            scope: 'user',
            configFields: CONFIG_FIELDS,
            source: source({
                contentWatch: {
                    when: 'spreadsheetId',
                    tool: 'sheets_get_values',
                    buildArgs: (filter) => ({
                        spreadsheetId: String(filter.spreadsheetId),
                        ...(composeRange(filter) ? { range: composeRange(filter) } : {}),
                    }),
                    itemsPath: 'values',
                    idPath: '$index',
                    changePaths: ['$'],
                    emit: {
                        mode: 'item',
                        map: { row: '$', rowIndex: '$index' },
                        includeChanges: true,
                    },
                    emitFromFilter: {
                        spreadsheetId: 'spreadsheetId',
                        sheet: 'sheet',
                        range: 'range',
                    },
                    // Rows are arrays of cell values and live in the shared
                    // 32 KB cursor budget — a whole watched range of previous
                    // values does not fit past a hundred or so rows.
                    maxTrackedItems: 100,
                },
            }),
        },
        {
            id: 'spreadsheet.new',
            label: 'New spreadsheet',
            fields: FILE_FIELDS,
            sample: { ...FILE_SAMPLE, changedKeys: [], previous: {}, current: { modifiedTime: FILE_SAMPLE.modifiedTime } },
            scope: 'user',
            // Appear-only: an edit to an existing sheet belongs to the event
            // above, so changePaths stays empty here.
            source: source({ changePaths: [], emitOnAppear: true }),
        },
    ],
}];

module.exports = { TRIGGER_SOURCES };
