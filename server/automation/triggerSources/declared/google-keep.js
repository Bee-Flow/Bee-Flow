/**
 * Google Keep. poll_diff over keep_list.
 *
 * keep_list already drops trashed notes, so a note moved to the bin simply
 * disappears from the listing — which is why the "note deleted" case is
 * declared via emitOnDisappear rather than a status field.
 */
const FIELDS = [
    'noteId', 'title', 'type', 'content', 'updateTime',
    'changedKeys', 'previous', 'current', 'changedAt',
];
const SAMPLE = {
    noteId: 'notes/abc123',
    title: 'Boodschappen',
    type: 'text',
    content: 'Koffie, brood, kaas',
    updateTime: '2026-06-14T07:22:41Z',
    changedKeys: ['content'],
    previous: { content: 'Koffie, brood' },
    current: { content: 'Koffie, brood, kaas' },
    changedAt: '2026-06-14T07:22:45.117Z',
};

const source = (over = {}) => ({
    kind: 'poll_diff',
    tool: 'keep_list',
    args: { maxResults: 50 },
    requiresIntegration: 'google-keep',
    itemsPath: 'results',
    idPath: 'noteId',
    changePaths: ['title', 'content', 'updateTime'],
    firstRun: 'anchor',
    minIntervalMs: 300_000,
    cacheTtlMs: 15_000,
    maxItemsPerTick: 25,
    maxTrackedItems: 100,
    trackValues: true,
    emit: {
        mode: 'item',
        map: {
            noteId: 'noteId', title: 'title', type: 'type',
            content: 'content', updateTime: 'updateTime',
        },
        includeChanges: true,
    },
    ...over,
});

const TRIGGER_SOURCES = [{
    id: 'google-keep',
    label: 'Google Keep',
    order: 34,
    defaultEvent: 'note.new',
    availability: { kind: 'tools', apps: ['google-keep'] },
    events: [
        {
            id: 'note.new',
            label: 'New note',
            fields: FIELDS,
            sample: { ...SAMPLE, changedKeys: [], previous: {}, current: { content: SAMPLE.content } },
            scope: 'user',
            source: source({ changePaths: [], emitOnAppear: true }),
        },
        {
            id: 'note.changed',
            label: 'Note edited',
            fields: FIELDS,
            sample: SAMPLE,
            scope: 'user',
            source: source(),
        },
    ],
}];

module.exports = { TRIGGER_SOURCES };
