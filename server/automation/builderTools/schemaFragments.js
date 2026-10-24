// @typecheck

const BINDING_HINT = 'Each input value must be a binding: {"kind":"literal","value":...} OR {"kind":"ref","path":"steps.<id>.output.<field>"} OR {"kind":"template","value":"... {{steps.x.output.y}} ..."} OR {"kind":"expr","value":"<restricted-js>"}.';

// Derived from the trigger-source declarations rather than typed out here: the
// hand-written lists had drifted into promising events that no longer exist.
const { providerList: APP_EVENT_PROVIDERS, eventList: APP_EVENT_EVENTS } =
    require('../triggerSources/describe').describeSourcesForPrompt();

// Likewise derived rather than typed out: the apps an `app_pick` question can
// offer come from the same registry the submit route validates against
// (automation/formPickSources.js), so the model is never told about a source
// the server would then refuse.
const PICK_SOURCES = require('../formPickSources').catalog()
    .map(sc => `${sc.id} (${sc.label})`).join(', ');

// The form-wizard attributes of a form question (phase 2). One definition for
// the trigger's form and for a further page, so the two never drift. The
// authoritative rules (caps, types, expression scope) live in
// automation/formTriggerContract.js and the validator; this is the plain-language
// face of them.
const FORM_FIELD_TYPES = ['text', 'textarea', 'email', 'number', 'date', 'select', 'radio', 'multiselect', 'checkbox', 'file', 'app_pick', 'info'];

const FORM_OPTIONS_HINT = 'Required when type=select, radio or multiselect. Each option is plain text and IS the value the answer holds, so a later switch matches on that exact text.';

const FORM_WIZARD_FIELD_PROPS = {
    content: { type: 'string', description: 'type=info only: the text shown to the visitor (markdown, up to 4000 characters). Nothing is asked and nothing is stored.' },
    showIf: { type: 'string', description: 'Show this question only when the expression is true, e.g. form.contact == "email", contains(form.topics, "billing") or !isEmpty(form.company). May only use form.<name> of questions ABOVE it on the same page. Checked again on the server: a hidden question never blocks, and its answer is dropped. Max 500 characters.' },
    min: { description: 'A number for type=number, a date string for type=date. type=number: the smallest allowed value, as a number (e.g. 0). type=date: the earliest date, YYYY-MM-DD. The visitor sees an inline error outside the range.' },
    max: { description: 'A number for type=number, a date string for type=date. type=number: the largest allowed value, as a number. type=date: the latest date, YYYY-MM-DD.' },
    minLength: { type: 'integer', description: 'type=text, textarea or email: the fewest characters allowed.' },
    maxLength: { type: 'integer', description: 'type=text, textarea or email: the most characters allowed.' },
    pattern: { type: 'string', description: 'type=text or textarea: the WHOLE answer must match this regular expression (RE2 syntax, up to 200 characters), e.g. "[A-Z]{2}-[0-9]{4}".' },
    patternMessage: { type: 'string', description: 'The inline error shown when `pattern` does not match, in the visitor\'s words (up to 120 characters).' },
    minSelected: { type: 'integer', description: 'type=multiselect: the fewest options that must be ticked.' },
    maxSelected: { type: 'integer', description: 'type=multiselect: the most options that may be ticked.' },
};

const FORM_LIST_SOURCE_PROPS = {
    ref: { type: 'string', description: 'Where the list lives in the run, e.g. "steps.load.output.rows". A path, never {{ }}.' },
    value: { type: 'string', description: 'Path inside one list item to its value. Omit when the list holds plain text or numbers.' },
    label: { type: 'string', description: 'Path inside one item to the text shown to the visitor. Defaults to the value.' },
    hint: { type: 'string', description: 'Path inside one item to a short extra line shown under the label.' },
    limit: { type: 'integer', description: 'Use at most this many items (1..10000).' },
};

// Only on a further form page: the trigger's page opens before any step ran, so
// there is no run data for it to draw from.
const FORM_PAGE_FIELD_PROPS = {
    optionsFrom: {
        type: 'object',
        description: 'type=select, radio or multiselect: build the choices from a list found earlier in the run instead of typing `options`. The ANSWER is each item\'s `value`; `label` is display only, so route on the value.',
        properties: FORM_LIST_SOURCE_PROPS,
        required: ['ref'],
    },
    fieldsFrom: {
        type: 'object',
        description: 'type=text, textarea, number, date, select, radio or checkbox: ask this question ONCE PER ITEM of an earlier list (each item\'s label becomes the question). The answer is steps.<page>.output.<name> = a list of {key, label, answer}, one per item. Keep `name` to 54 characters.',
        properties: FORM_LIST_SOURCE_PROPS,
        required: ['ref'],
    },
};

// BFSF-485: the one thing a condition does not do. A model asked to "only
// process the sheets named X" reaches for builder_add_condition, and every
// sheet is processed anyway.
const WHOLE_RUN_DOCTRINE = 'A condition decides ONCE for the whole run: one that reads a list (`list[*]`) sends every item the same way. '
    + 'To keep only the matching items of a list use builder_add_array_op({op:"filter"}) and continue on its output.items.';

const SPLICE_DESCRIPTION = 'Default false: the new step is added BESIDE the current successor of afterStepId (that edge stays, so the two run in parallel). true: INSERT the new step between afterStepId and its current successor(s) - the successor edge is re-pointed to the new step, so downstream steps can depend on it. Pass branch/caseName as well when the anchor is a condition/switch. A switch can only be spliced in when it has arrayRef (the old successor moves to its first case).';

module.exports = { BINDING_HINT, APP_EVENT_PROVIDERS, APP_EVENT_EVENTS, PICK_SOURCES, FORM_FIELD_TYPES, FORM_OPTIONS_HINT, FORM_WIZARD_FIELD_PROPS, FORM_PAGE_FIELD_PROPS, WHOLE_RUN_DOCTRINE, SPLICE_DESCRIPTION };
