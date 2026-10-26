// @typecheck strict
/**
 * Form field vocabulary: the types, the predicates over them, the length
 * limits and the two operator-tunable caps.
 *
 * Split out of formTriggerContract.js (which stays the facade and re-exports
 * every name here) so the rule, dynamic-field and coercion modules can share
 * the vocabulary without requiring the facade back.
 *
 * Pure: no I/O. Safe to require from stores, routes and tests.
 */

'use strict';

const { envCap } = require('./mcpRunReadCaps');

const FIELD_TYPES = Object.freeze([
    'text', 'textarea', 'email', 'number', 'date',
    'select', 'radio', 'multiselect', 'checkbox',
    'file', 'app_pick', 'download', 'notebook', 'info',
]);

/**
 * Field types that DISPLAY something instead of collecting it.
 *
 * `download` and `notebook` hand the visitor a file a `generate_document` or
 * `fill_document` step produced; `info` is a block of text. They live in
 * `fields` because that is where a form's page furniture already is, but every
 * input-shaped code path has to step over them: they are never submitted,
 * never required, never coerced, have no initial value and no answers column.
 * Treating one as an input would make a form with a download button on it
 * permanently un-submittable.
 */
const DISPLAY_FIELD_TYPES = Object.freeze(['download', 'notebook', 'info']);

/**
 * Display fields that point at a generated file by id. Same shape, same
 * authoring slot, same "the route resolves it" rule; only the button differs.
 */
const FILE_FIELD_TYPES = Object.freeze(['download', 'notebook']);

/** Questions answered by picking from a closed list of values. */
const CHOICE_FIELD_TYPES = Object.freeze(['select', 'radio', 'multiselect']);

const isDisplayField = (/** @type {{ type: string; }} */ f) => DISPLAY_FIELD_TYPES.includes(f?.type);
const isFileField = (/** @type {{ type: string; }} */ f) => FILE_FIELD_TYPES.includes(f?.type);
/** A question answered by picking a record in an app the FILLER has access to. */
const isPickField = (/** @type {{ type: string; }} */ f) => f?.type === 'app_pick';
const isChoiceField = (/** @type {{ type: string; }} */ f) => CHOICE_FIELD_TYPES.includes(f?.type);
const isInfoField = (/** @type {{ type: string; }} */ f) => f?.type === 'info';
/** A field whose choices or whose questions come from run data. */
const isDynamicField = (/** @type {{ optionsFrom?: unknown, fieldsFrom?: unknown, [k: string]: unknown } | null | undefined} */ f) => !!(f && (f.optionsFrom || f.fieldsFrom));

const MAX_FIELDS = 40;
const MAX_LABEL_LEN = 120;
const MAX_TEXT_LEN = 2000;          // title / description / successMessage, as AUTHORED
// A description is the one text on a form page that routinely carries
// INTERPOLATED run output: a closing page whose whole job is to show what the
// automation produced. The authored template stays bounded by MAX_TEXT_LEN
// (it is only a few {{refs}}); what it renders TO is bounded separately and far
// higher, or the page silently truncates the result mid-sentence.
const MAX_RENDERED_DESCRIPTION_LEN = 20000;
const MAX_PLACEHOLDER_LEN = 120;
const MAX_OPTION_LEN = 120;
const MAX_OPTION_HINT_LEN = 200;
const MAX_INFO_LEN = 4000;          // an info block, as AUTHORED
const MAX_SHOW_IF_LEN = 500;
const MAX_PATTERN_LEN = 200;
const MAX_PATTERN_MESSAGE_LEN = 120;
const MAX_SOURCE_PATH_LEN = 500;
const MAX_SOURCE_LIMIT = 10000;
// `<name>__<i>` has to stay a valid field name (60 chars): 54 + "__" + 4 digits.
const MAX_FIELDS_FROM_NAME_LEN = 54;
const MAX_GROUP_ITEMS = 9999;
// Server-side ceiling on a per-field `maxSizeMb`. uploadGuard's own default is
// 25MB; a form author may lower it but never raise it past this.
const MAX_UPLOAD_MB = 25;
const DEFAULT_UPLOAD_MB = 10;
// A textarea is the one field where a long answer is the point.
const MAX_TEXTAREA_LEN = 20000;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
// Names the runtime mints for the questions a `fieldsFrom` template expands
// into. An author may not use one, or it would collide with an expansion.
const RESERVED_NAME_RE = /__\d+$/;

/** How many choices one question may offer (env AUTOMATION_FORM_MAX_OPTIONS; 0 = unlimited). */
const formOptionsCap = () => envCap('AUTOMATION_FORM_MAX_OPTIONS', 200);
/** How many questions one `fieldsFrom` template may expand into (env AUTOMATION_FORM_MAX_FIELDS_FROM; 0 = unlimited). */
const formFieldsFromCap = () => envCap('AUTOMATION_FORM_MAX_FIELDS_FROM', 50);

/** @param {unknown} v */
function isPlainObject(v) {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
}

module.exports = {
    FIELD_TYPES,
    DISPLAY_FIELD_TYPES,
    FILE_FIELD_TYPES,
    CHOICE_FIELD_TYPES,
    isDisplayField,
    isFileField,
    isPickField,
    isChoiceField,
    isInfoField,
    isDynamicField,
    isPlainObject,
    MAX_FIELDS,
    MAX_LABEL_LEN,
    MAX_TEXT_LEN,
    MAX_RENDERED_DESCRIPTION_LEN,
    MAX_PLACEHOLDER_LEN,
    MAX_OPTION_LEN,
    MAX_OPTION_HINT_LEN,
    MAX_INFO_LEN,
    MAX_SHOW_IF_LEN,
    MAX_PATTERN_LEN,
    MAX_PATTERN_MESSAGE_LEN,
    MAX_SOURCE_PATH_LEN,
    MAX_SOURCE_LIMIT,
    MAX_FIELDS_FROM_NAME_LEN,
    MAX_GROUP_ITEMS,
    MAX_UPLOAD_MB,
    DEFAULT_UPLOAD_MB,
    MAX_TEXTAREA_LEN,
    EMAIL_RE,
    DATE_RE,
    RESERVED_NAME_RE,
    formOptionsCap,
    formFieldsFromCap,
};
