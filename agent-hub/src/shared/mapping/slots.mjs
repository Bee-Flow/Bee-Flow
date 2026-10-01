/**
 * Slots: what a field wants, as the `as` of a pick (intent.mjs).
 *
 *   text    a text; `multiLine` says whether a list goes in one per line
 *           (a message body) or comma-separated (a subject)
 *   list    a list; `items` is the shape of one item when known
 *   number, date, yesno
 *   json    structured data sent as is (an HTTP body)
 *   native  not known: the value goes in as the source has it
 *
 * A tool's input has a JSON schema and the slot comes from it. A step's own
 * config fields (a notification's body, an HTTP request's url) have none, so
 * STEP_SLOTS says what each one is. Anything neither knows is `native`, which
 * is what a legacy ref has always done.
 */

import { shapeOfSchema } from './shape.mjs';

export const SLOT_KINDS = Object.freeze(['text', 'list', 'number', 'date', 'yesno', 'json', 'native']);

const text = (multiLine) => Object.freeze({ as: 'text', multiLine });
const LINE = text(false);
const LINES = text(true);

/**
 * The step config fields that take a value, keyed `<step type>.<field>`
 * (a nested field dotted: `return_to_app.toast.message`). Every text field
 * here is one sites.mjs lists as a text site of that step type.
 */
export const STEP_SLOTS = Object.freeze({
    'ai_step.prompt': LINES,
    'approval.prompt': LINES,
    'approval.approval.details': LINES,
    'notification.title': LINE,
    'notification.body': LINES,
    'http_request.url': LINE,
    'http_request.body': Object.freeze({ as: 'json', multiLine: true }),
    'stop_error.message': LINES,
    'return_to_app.toast.message': LINE,
    'return_to_app.navigateTo.recordRef': LINE,
    'data_extraction.source': LINES,
    'generate_document.content': LINES,
    'generate_document.title': LINE,
    'generate_document.fileName': LINE,
    'fill_document.fileName': LINE,
    'fill_document.copyName': LINE,
    'fill_document.values': LINES,
    'knowledge_write.content': LINES,
    'knowledge_write.title': LINE,
    'knowledge_write.sourceUri': LINE,
    'slide.title': LINE,
    'slide.content': LINES,
    'slide.notes': LINES,
    'slide.image': LINE,
    'presentation.title': LINE,
    'presentation.subtitle': LINE,
    'presentation.fileName': LINE,
    'presentation.copyName': LINE,
});

// A text input of a tool that reads as running text rather than one line.
const MULTI_LINE_NAME = /(body|content|description|message|text|notes|prompt|summary|comment)$/i;

function isRecord(v) {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function schemaTypes(schema) {
    const t = schema.type;
    const list = typeof t === 'string' ? [t] : (Array.isArray(t) ? t : []);
    return list.filter(x => typeof x === 'string' && x !== 'null');
}

/**
 * The slot a field is: from its JSON schema when it has one that says,
 * else from STEP_SLOTS, else `native`.
 * @param {unknown} schema — the field's JSON schema, if any
 * @param {{ stepType?: string, field?: string }} [where]
 * @returns {{ as: string, multiLine: boolean, items?: string }}
 */
export function slotShape(schema, { stepType, field } = {}) {
    if (isRecord(schema)) {
        const types = schemaTypes(schema);
        const shape = shapeOfSchema(schema);
        if (shape === 'list' || shape === 'table') {
            const items = isRecord(schema.items) ? shapeOfSchema(schema.items) : 'unknown';
            return { as: 'list', multiLine: false, items };
        }
        if (types.includes('number') || types.includes('integer')) return { as: 'number', multiLine: false };
        if (types.includes('boolean')) return { as: 'yesno', multiLine: false };
        if (types.includes('string')) {
            if (schema.format === 'date' || schema.format === 'date-time') return { as: 'date', multiLine: false };
            const multiLine = schema['x-multiline'] === true || schema.format === 'textarea'
                || (typeof field === 'string' && MULTI_LINE_NAME.test(field));
            return { as: 'text', multiLine };
        }
    }
    const key = typeof stepType === 'string' && typeof field === 'string' ? `${stepType}.${field}` : null;
    if (key && Object.prototype.hasOwnProperty.call(STEP_SLOTS, key)) return { ...STEP_SLOTS[key] };
    return { as: 'native', multiLine: false };
}
