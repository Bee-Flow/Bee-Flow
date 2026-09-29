/**
 * Google Sheets. No hand-written poller and no Google push channel — both
 * events come from the generic poll_diff runtime diffing what sheets_list
 * already returns, which is the point of declaration-driven triggers: a
 * connected app becomes a trigger source without new platform code.
 *
 * Watching a spreadsheet's CONTENTS (a new row, a changed cell) would need
 * sheets_get_values with a per-subscription spreadsheet id, and source
 * arguments are static in v1. Until that lands, "changed" means the file's
 * modifiedTime moved — which is what Drive reports the moment anyone edits it.
 */
const FIELDS = ['id', 'name', 'url', 'modifiedTime', 'changedKeys', 'previous', 'current', 'changedAt'];
const SAMPLE = {
    id: '1AbCDeFgHiJkLmNoPqRsTuV',
    name: 'Invoice tracker 2026',
    url: 'https://docs.google.com/spreadsheets/d/1AbCDeFgHiJkLmNoPqRsTuV/edit',
    modifiedTime: '2026-05-12T10:23:00Z',
    changedKeys: ['modifiedTime'],
    previous: { modifiedTime: '2026-05-11T09:02:00Z' },
    current: { modifiedTime: '2026-05-12T10:23:00Z' },
    changedAt: '2026-05-12T10:23:04.881Z',
};

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
            fields: FIELDS,
            sample: SAMPLE,
            scope: 'user',
            source: source(),
        },
        {
            id: 'spreadsheet.new',
            label: 'New spreadsheet',
            fields: FIELDS,
            sample: { ...SAMPLE, changedKeys: [], previous: {}, current: { modifiedTime: SAMPLE.modifiedTime } },
            scope: 'user',
            // Appear-only: an edit to an existing sheet belongs to the event
            // above, so changePaths stays empty here.
            source: source({ changePaths: [], emitOnAppear: true }),
        },
    ],
}];

module.exports = { TRIGGER_SOURCES };
