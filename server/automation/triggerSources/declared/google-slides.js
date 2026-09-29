/**
 * Google Slides. Same shape as the Sheets declaration: poll_diff over
 * slides_list, which already reports each presentation's modifiedTime.
 */
const FIELDS = ['id', 'name', 'url', 'modifiedTime', 'changedKeys', 'previous', 'current', 'changedAt'];
const SAMPLE = {
    id: '1PrEsIdSlIdEsAbCdEfG',
    name: 'Q1 review template',
    url: 'https://docs.google.com/presentation/d/1PrEsIdSlIdEsAbCdEfG/edit',
    modifiedTime: '2026-04-22T08:11:00Z',
    changedKeys: ['modifiedTime'],
    previous: { modifiedTime: '2026-04-20T16:40:00Z' },
    current: { modifiedTime: '2026-04-22T08:11:00Z' },
    changedAt: '2026-04-22T08:11:06.203Z',
};

const source = (over = {}) => ({
    kind: 'poll_diff',
    tool: 'slides_list',
    args: { pageSize: 100 },
    requiresIntegration: 'google-slides',
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
    id: 'google-slides',
    label: 'Google Slides',
    order: 32,
    defaultEvent: 'presentation.changed',
    availability: { kind: 'tools', apps: ['google-slides'] },
    events: [
        {
            id: 'presentation.changed',
            label: 'Presentation edited',
            fields: FIELDS,
            sample: SAMPLE,
            scope: 'user',
            source: source(),
        },
        {
            id: 'presentation.new',
            label: 'New presentation',
            fields: FIELDS,
            sample: { ...SAMPLE, changedKeys: [], previous: {}, current: { modifiedTime: SAMPLE.modifiedTime } },
            scope: 'user',
            source: source({ changePaths: [], emitOnAppear: true }),
        },
    ],
}];

module.exports = { TRIGGER_SOURCES };
