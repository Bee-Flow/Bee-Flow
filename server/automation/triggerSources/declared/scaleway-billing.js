/**
 * Scaleway Billing. No hand-written poller and no push channel: Scaleway has no
 * billing webhooks, so "a new invoice" comes from the generic poll_diff runtime
 * diffing what scaleway_list_invoices already returns.
 *
 * Appear-only: an invoice that changes state (issued → paid) is not a new
 * invoice, so changePaths stays empty and only first sightings fire. Scaleway
 * issues one periodic invoice a month, so polling every six hours is plenty
 * and keeps the billing API well inside its rate limits.
 */
const FIELDS = ['id', 'number', 'billingPeriod', 'issuedDate', 'dueDate', 'type', 'currency', 'totalInclVat', 'fileName'];
const SAMPLE = {
    id: '3f2a9c1e-5b7d-4e8f-9a0b-1c2d3e4f5a6b',
    number: 1234567,
    billingPeriod: '2026-09',
    issuedDate: '2026-10-01',
    dueDate: '2026-10-31',
    type: 'periodic',
    currency: 'EUR',
    totalInclVat: 121.37,
    fileName: 'Scaleway-2026-09-1234567.pdf',
};

const TRIGGER_SOURCES = [{
    id: 'scaleway-billing',
    label: 'Scaleway Billing',
    order: 100,
    defaultEvent: 'invoice.new',
    availability: { kind: 'tools', apps: ['scaleway-billing'] },
    events: [
        {
            id: 'invoice.new',
            label: 'New Scaleway invoice',
            fields: FIELDS,
            sample: SAMPLE,
            scope: 'user',
            source: {
                kind: 'poll_diff',
                tool: 'scaleway_list_invoices',
                args: { limit: 50 },
                requiresIntegration: 'scaleway-billing',
                itemsPath: 'invoices',
                idPath: 'id',
                changePaths: [],
                emitOnAppear: true,
                firstRun: 'anchor',
                minIntervalMs: 6 * 3_600_000,
                maxTrackedItems: 200,
                emit: {
                    mode: 'item',
                    map: Object.fromEntries(FIELDS.map(f => [f, f])),
                },
            },
        },
    ],
}];

module.exports = { TRIGGER_SOURCES };
