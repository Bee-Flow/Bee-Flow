/**
 * Google Contacts. poll_diff over contacts_list.
 *
 * The People API caps a listing at 50 per call and this source takes the
 * maximum, so an address book larger than that is watched only down to its
 * first 50 by first name. The runtime marks such a cursor truncated and
 * suppresses appear-events rather than announcing a "new" contact every time
 * the page boundary shifts.
 */
const FIELDS = [
    'resourceName', 'displayName', 'firstName', 'lastName', 'email', 'phone', 'company',
    'changedKeys', 'previous', 'current', 'changedAt',
];
const SAMPLE = {
    resourceName: 'people/c1234567890',
    displayName: 'Sanne de Vries',
    firstName: 'Sanne',
    lastName: 'de Vries',
    email: 'sanne@example.com',
    phone: '+31 6 12345678',
    company: 'Example BV',
    changedKeys: ['email'],
    previous: { email: 's.devries@example.com' },
    current: { email: 'sanne@example.com' },
    changedAt: '2026-06-02T11:45:12.004Z',
};

const source = (over = {}) => ({
    kind: 'poll_diff',
    tool: 'contacts_list',
    args: { maxResults: 50 },
    requiresIntegration: 'google-contacts',
    itemsPath: 'results',
    idPath: 'resourceName',
    changePaths: ['displayName', 'email', 'phone', 'company'],
    firstRun: 'anchor',
    minIntervalMs: 600_000,
    cacheTtlMs: 15_000,
    maxItemsPerTick: 25,
    maxTrackedItems: 100,
    trackValues: true,
    emit: {
        mode: 'item',
        map: {
            resourceName: 'resourceName', displayName: 'displayName',
            firstName: 'firstName', lastName: 'lastName',
            email: 'email', phone: 'phone', company: 'company',
        },
        includeChanges: true,
    },
    ...over,
});

const TRIGGER_SOURCES = [{
    id: 'google-contacts',
    label: 'Google Contacts',
    order: 33,
    defaultEvent: 'contact.new',
    availability: { kind: 'tools', apps: ['google-contacts'] },
    events: [
        {
            id: 'contact.new',
            label: 'New contact',
            fields: FIELDS,
            sample: { ...SAMPLE, changedKeys: [], previous: {}, current: { email: SAMPLE.email } },
            scope: 'user',
            source: source({ changePaths: [], emitOnAppear: true }),
        },
        {
            id: 'contact.changed',
            label: 'Contact details changed',
            fields: FIELDS,
            sample: SAMPLE,
            scope: 'user',
            source: source(),
        },
    ],
}];

module.exports = { TRIGGER_SOURCES };
