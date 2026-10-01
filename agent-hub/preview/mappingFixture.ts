/**
 * Fake data for the mapping preview (mapping-preview.html): a webhook that
 * delivers a customer with orders, each with order lines, and a Gmail step
 * whose fields get mapped. Deliberately nested, so the screenshots show how
 * the builder copes with complex JSON. No backend is involved.
 */
type Json = Record<string, unknown>;

export const TRIGGER_OUTPUT = {
    customer: {
        name: 'Anna de Vries',
        email: 'anna@voorbeeld.nl',
        'phone number': '+31 6 1234 5678',
        address: { street: 'Oudegracht 12', city: 'Utrecht', postcode: '3511 AB' },
    },
    orders: [
        { id: 'A-100', total: 129.5, lines: [{ product: 'Bureaustoel', qty: 1, price: 99.5 }, { product: 'Lamp', qty: 2, price: 15 }] },
        { id: 'A-101', total: 49, lines: [{ product: 'Muismat', qty: 3, price: 5 }, { product: 'Toetsenbord', qty: 1, price: 34 }] },
    ],
    tags: ['vip', 'nieuwe klant'],
    contacts: [
        { naam: 'Anna de Vries', 'E-mail': 'anna@voorbeeld.nl' },
        { naam: 'Jan Jansen', 'E-mail': 'jan@voorbeeld.nl' },
    ],
};

export const FETCH_OUTPUT = {
    status: 200,
    ok: true,
    data: { results: [{ subject: 'Levering vertraagd', from: 'logistiek@leverancier.nl' }, { subject: 'Factuur 2026-118', from: 'factuur@leverancier.nl' }] },
};

const GMAIL_SEND_SCHEMA = {
    type: 'object',
    properties: {
        to: { type: 'string', description: 'Recipient e-mail address' },
        cc: { type: 'array', items: { type: 'string' }, description: 'Extra recipients' },
        subject: { type: 'string', description: 'Subject line' },
        body: { type: 'string', description: 'Message text' },
        priority: { type: 'number', description: 'Priority 1-5' },
    },
    required: ['to', 'subject', 'body'],
};

export const CATALOG = {
    apps: [{
        id: 'gmail', label: 'Gmail', available: true,
        actions: [{ name: 'gmail_send_email', label: 'Send email', inputSchema: GMAIL_SEND_SCHEMA, outputSchema: null, outputSample: null, sideEffect: true, effect: 'sends', integrationId: 'gmail', integrationLabel: 'Gmail' }],
    }, {
        id: 'http', label: 'HTTP', available: true, actions: [],
    }],
    triggerOutputs: {},
    triggers: [],
    flags: {},
    topics: [],
};

const pick = (path: Array<string | number>, intent: Json, root: Json = { root: 'trigger' }) => ({
    kind: 'pick', v: 1, from: { ...root, path }, ...intent,
});

/**
 * Input bindings per scenario (?s=...). The first ones are what the builder
 * stored before the value slots (legacy refs, templates, formulas: shown as
 * chips where they lift, as a Formula chip where they do not); the `pick-*`
 * ones are what the value slots store, one per state the screenshots need.
 */
export const SCENARIOS: Record<string, Json> = {
    empty: {},
    single: { to: { kind: 'ref', path: 'trigger.output.customer.email' } },
    'list-in-text': {
        to: { kind: 'ref', path: 'trigger.output.customer.email' },
        body: { kind: 'template', value: 'Beste {{trigger.output.customer.name}},\n\nUw producten: {{trigger.output.orders[*].lines[*].product}}' },
    },
    'table-in-list': { cc: { kind: 'ref', path: 'trigger.output.orders' } },
    formula: { subject: { kind: 'expr', value: 'join(steps.fetch.output.data.results[*].subject, ", ")' } },
    'key-with-space': { body: { kind: 'template', value: 'Bel {{trigger.output.customer["phone number"]}}' } },
    'many-into-number': { priority: { kind: 'ref', path: 'trigger.output.orders[*].total' } },
    // The value slots (M4): a list into text, said in one sentence.
    'pick-list-in-text': {
        to: pick(['customer', 'email'], { take: 'one', as: 'text' }),
        body: pick(['orders', 'lines', 'product'], { take: 'all', as: 'text', join: 'lines' }),
    },
    // A whole table into a list field: no column matches "cc" (amber), or the
    // column was chosen ("Which column? [E-mail]").
    'pick-column-choice': { cc: pick(['contacts'], { take: 'all', as: 'list' }) },
    'pick-column-picked': { cc: pick(['contacts', 'E-mail'], { take: 'all', as: 'list' }) },
    // Many values into a number: the first, in amber.
    'pick-many-into-number': { priority: pick(['orders', 'total'], { take: 'first', as: 'number' }) },
    // A source that is gone (its step was removed): the amber chip.
    'pick-stale': { to: pick(['email'], { take: 'one', as: 'text' }, { root: 'steps', id: 'removed' }) },
    // A formula that does not read as one value: the grey Formula chip.
    'legacy-formula': { subject: { kind: 'expr', value: 'upper(trigger.output.customer.name) + " · " + count(trigger.output.orders)' } },
    // Typed text with a value after it.
    'pick-text-with-value': {
        subject: { kind: 'compose', v: 1, parts: ['Uw bestelling ', { from: { root: 'trigger', path: ['orders', 0, 'id'] }, take: 'one', as: 'text' }] },
    },
    // The step runs once per contact (REPEATS): "Current contact" on top of
    // Comes in, and a value picked from it reads that one contact.
    'repeat-current-item': {
        to: pick(['contacts', 'E-mail'], { take: 'each', as: 'text' }),
        subject: { kind: 'compose', v: 1, parts: ['Hallo ', { from: { root: 'trigger', path: ['contacts', 'naam'] }, take: 'each', as: 'text' }] },
    },
};

/** The steps that run once per item, per scenario (`step.repeat`). */
export const REPEATS: Record<string, Json> = {
    'repeat-current-item': { over: { root: 'trigger', path: ['contacts'] }, max: 100 },
};

const NAME = { from: { root: 'trigger', path: ['customer', 'name'] }, take: 'one', as: 'text', label: 'Name' };
const PRODUCTS = { from: { root: 'trigger', path: ['orders', 'lines', 'product'] }, take: 'all', as: 'text', join: 'lines', label: 'Product' };

/**
 * Whole steps per scenario (?s=...), for the text fields with values in them
 * (ComposeField): the step drawer opens on this step instead of the Gmail one.
 */
export const STEP_SCENARIOS: Record<string, Json> = {
    // What the AI builder stores: a composed body with a list in it ("≡ 4").
    'compose-body': {
        type: 'notification', label: 'Bevestiging sturen',
        title: { kind: 'compose', v: 1, parts: ['Bestelling van ', NAME] },
        body: { kind: 'compose', v: 1, parts: ['Beste ', NAME, ',\n\nUw producten:\n', PRODUCTS, '\n\nMet vriendelijke groet'] },
    },
    // A body saved before the v2 mapping: shown as pills, lifted only on edit.
    // The title reads one row by index, which stays a template.
    'template-body': {
        type: 'notification', label: 'Bevestiging sturen',
        title: 'Bestelling {{trigger.output.orders[0].id}}',
        body: 'Beste {{trigger.output.customer.name}},\n\nUw producten: {{trigger.output.orders[*].lines[*].product}}',
    },
    // An AI step prompt: values from earlier steps and its own input by name.
    'prompt-pills': {
        type: 'ai_step', label: 'Antwoord opstellen',
        prompt: 'Schrijf een korte bevestiging aan {{trigger.output.customer.name}} over {{trigger.output.orders[*].lines[*].product}}.\nGebruik een {{toon}} toon.',
        inputs: { toon: { kind: 'literal', value: 'vriendelijke' } },
    },
    // Empty text fields: the grey example names values, never a path.
    'compose-empty': { type: 'notification', label: 'Bevestiging sturen', title: '', body: '' },
};

export function definitionFor(scenario: string) {
    const trigger = { id: 'trg', type: 'trigger', kind: 'webhook', label: 'Bestelling ontvangen', pinnedOutput: TRIGGER_OUTPUT };
    const fetch = { id: 'fetch', type: 'http_request', label: 'Berichten ophalen', method: 'GET', url: 'https://api.voorbeeld.nl/berichten', pinnedOutput: FETCH_OUTPUT };
    const mail = STEP_SCENARIOS[scenario]
        ? { id: 'mail', ...STEP_SCENARIOS[scenario] }
        : {
            id: 'mail', type: 'integration_action', tool: 'gmail_send_email', label: 'Bevestiging mailen', inputs: SCENARIOS[scenario] || {},
            ...(REPEATS[scenario] ? { repeat: REPEATS[scenario] } : {}),
        };
    return {
        definition: { trigger, steps: [fetch, mail], edges: [{ from: 'trg', to: 'fetch' }, { from: 'fetch', to: 'mail' }] },
        step: mail,
    };
}
