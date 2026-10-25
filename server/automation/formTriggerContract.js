/**
 * Form-trigger contract helpers.
 *
 * A `form` automation is fired by a submission on a PUBLIC page Bee Flow hosts
 * at `/f/<token>`. The author declares the fields in the definition:
 * `definition.trigger.form = { title, description?, submitLabel?,
 * successMessage?, fields: [...], theme? }`. This module is the single home for
 * that contract — the declaration rules (automation/validate.js on save), the
 * render config the public page receives, and the runtime coercion the public
 * submit route applies.
 *
 * Three deliberate properties:
 *
 *   • The URL TOKEN is not in the definition. Exporting/importing/duplicating a
 *     automation must never clone a live public URL, so the token lives only in
 *     the automation_form_pages row (mirroring automation_webhooks).
 *   • Files never travel as bytes. A `file` field's submitted value is a
 *     descriptor `{ kind: 'form_upload', fileId }` produced by the separate
 *     upload call — the same idea as app_trigger's `studio_attachment`.
 *   • coerceSubmission iterates the DECLARED FIELDS, never Object.keys(body).
 *     That is what makes `__proto__`/`constructor` in a submitted body
 *     structurally unable to reach the values object.
 *
 * Intentionally dependency-light (like appTriggerContract.js): pure functions,
 * no I/O, safe to require from stores and routes.
 */

'use strict';

const { PARAM_NAME_RE } = require('./appTriggerContract');
const { canonicalizeTheme, validateTheme } = require('../core/cms/themeSpec');
const pickSources = require('./formPickSources');
const types = require('./formFieldTypes');
const rules = require('./formFieldRules');
const dynamic = require('./formDynamicFields');
const coerce = require('./formCoerce');

// The module layout: formFieldTypes (vocabulary, limits, caps), formFieldRules
// (rules + showIf), formDynamicFields (optionsFrom / fieldsFrom) and formCoerce
// (submission coercion). This file is the facade: it normalizes, validates and
// renders a declaration, and re-exports every name those modules own.
const {
    FIELD_TYPES, DISPLAY_FIELD_TYPES, FILE_FIELD_TYPES, CHOICE_FIELD_TYPES,
    isDisplayField, isFileField, isPickField, isChoiceField, isDynamicField, isPlainObject,
    MAX_FIELDS, MAX_LABEL_LEN, MAX_TEXT_LEN, MAX_RENDERED_DESCRIPTION_LEN, MAX_PLACEHOLDER_LEN,
    MAX_OPTION_LEN, MAX_OPTION_HINT_LEN, MAX_INFO_LEN, MAX_UPLOAD_MB, DEFAULT_UPLOAD_MB,
    RESERVED_NAME_RE, formOptionsCap, formFieldsFromCap,
} = types;
const { coerceFieldValue, coerceSubmission } = coerce;

/** True when a definition's PRIMARY trigger is a form trigger. */
function isFormTriggerDefinition(definition) {
    return definition?.trigger?.kind === 'form';
}

function normalizeOptions(raw) {
    if (!Array.isArray(raw)) return [];
    const cap = formOptionsCap();
    const out = [];
    for (const o of raw) {
        // Both `["Sales","Support"]` and `[{value,label,hint}]` are accepted; the
        // builder writes plain strings, the AI builder sometimes writes objects.
        const value = typeof o === 'string' ? o : (isPlainObject(o) ? o.value : null);
        if (typeof value !== 'string' || !value.trim()) continue;
        const text = (v) => (typeof v === 'string' && v.trim() ? v : null);
        const label = (isPlainObject(o) && text(o.label)) || value;
        const hint = isPlainObject(o) ? text(o.hint) : null;
        out.push({
            value: value.slice(0, MAX_OPTION_LEN),
            label: label.slice(0, MAX_OPTION_LEN),
            ...(hint ? { hint: hint.slice(0, MAX_OPTION_HINT_LEN) } : {}),
        });
        if (cap > 0 && out.length >= cap) break;
    }
    return out;
}

/**
 * Wrap an author-supplied interpolator so a broken template can never take a
 * page down: on any throw the RAW string is returned, never a partial render.
 * `null` means "no templating" — the trigger's own page never interpolates,
 * because at GET time there is no run state to interpolate against.
 */
function makeInterpolator(interpolate) {
    if (typeof interpolate !== 'function') return (s) => s;
    return (s) => {
        if (typeof s !== 'string' || !s) return s;
        try {
            const out = interpolate(s);
            return typeof out === 'string' ? out : s;
        } catch (_) {
            return s;
        }
    };
}

/**
 * Normalized declared fields. Invalid entries are DROPPED rather than repaired
 * — validateFormDeclaration is what tells the author about them; this
 * function's job is to give the runtime something it can always trust.
 *
 * `interpolate` (form_page steps only) templates the HUMAN-READABLE parts —
 * label, placeholder, help and option LABELS. Option `value`s are deliberately
 * left raw: they are the closed vocabulary coerceSubmission checks a submitted
 * answer against, so templating them would make the rendered choices and the
 * accepted choices disagree.
 */
function normalizeFields(form, { interpolate = null } = {}) {
    const raw = form?.fields;
    if (!Array.isArray(raw)) return [];
    const t = makeInterpolator(interpolate);
    const seen = new Set();
    const out = [];
    // MAX_FIELDS bounds what an author declares; the questions a fieldsFrom
    // template expands into are bounded per group (formFieldsFromCap) instead.
    let declared = 0;
    const perGroup = new Map();
    const groupCap = formFieldsFromCap();
    for (const f of raw) {
        if (!isPlainObject(f)) continue;
        if (typeof f.name !== 'string' || !PARAM_NAME_RE.test(f.name) || seen.has(f.name)) continue;
        const group = typeof f.group === 'string' && f.group ? f.group.slice(0, 60) : '';
        if (!group && declared >= MAX_FIELDS) break;
        if (group && f.groupHeader !== true && groupCap > 0 && (perGroup.get(group) || 0) >= groupCap) continue;
        seen.add(f.name);
        const type = FIELD_TYPES.includes(f.type) ? f.type : 'text';
        const label = typeof f.label === 'string' ? t(f.label).trim() : '';
        const field = {
            name: f.name,
            type,
            // An info block's heading is optional: blank stays blank, never its internal name.
            label: label ? label.slice(0, MAX_LABEL_LEN) : (type === 'info' ? '' : f.name),
            required: !!f.required,
            placeholder: typeof f.placeholder === 'string' ? t(f.placeholder).slice(0, MAX_PLACEHOLDER_LEN) : '',
            help: typeof f.help === 'string' ? t(f.help).slice(0, MAX_PLACEHOLDER_LEN) : '',
        };
        if (isChoiceField(field)) {
            field.options = normalizeOptions(f.options).map(o => ({ ...o, label: t(o.label).slice(0, MAX_OPTION_LEN) || o.value }));
            // The run found nothing to choose from: not required, or nobody could submit.
            if (f.noOptions === true) { field.noOptions = true; field.required = false; }
        }
        if (type === 'info') {
            field.required = false;
            field.content = typeof f.content === 'string' ? t(f.content).slice(0, MAX_RENDERED_DESCRIPTION_LEN) : '';
        }
        Object.assign(field, rules.normalizeRules(f, type));
        const showIf = rules.normalizeShowIf(f.showIf);
        if (showIf) field.showIf = showIf;
        // The source specs of dynamic fields stay on an AUTHORED field (the
        // builder, the answers table and validation read them); the rendered
        // config replaces them with their result.
        const optionsFrom = isChoiceField(field) ? dynamic.normalizeSourceSpec(f.optionsFrom) : null;
        if (optionsFrom) field.optionsFrom = optionsFrom;
        const fieldsFrom = dynamic.FIELDS_FROM_TYPES.includes(type) ? dynamic.normalizeSourceSpec(f.fieldsFrom) : null;
        if (fieldsFrom && !field.optionsFrom) field.fieldsFrom = fieldsFrom;
        if (typeof f.group === 'string' && f.group) {
            field.group = f.group.slice(0, 60);
            if (typeof f.groupKey === 'string') field.groupKey = f.groupKey.slice(0, MAX_OPTION_LEN);
            if (f.groupHeader === true) field.groupHeader = true;
        }
        if (type === 'file') {
            field.accept = typeof f.accept === 'string' ? f.accept.slice(0, 300) : '';
            const mb = Number(f.maxSizeMb);
            field.maxSizeMb = Number.isFinite(mb) && mb > 0 ? Math.min(MAX_UPLOAD_MB, Math.ceil(mb)) : DEFAULT_UPLOAD_MB;
        }
        if (type === 'app_pick') {
            // The SOURCE is resolved here, not trusted from the wire. A field
            // naming a source that no longer exists keeps its `source` (so the
            // author sees what they chose and validateFormDeclaration can say
            // so) but carries no app metadata — and every runtime path below
            // treats "no resolved source" as "nothing can be picked", rather
            // than falling through to some default app.
            const source = pickSources.getSource(f.source);
            field.source = typeof f.source === 'string' ? f.source.slice(0, 60) : '';
            field.app = source ? source.app : '';
            field.sourceLabel = source ? source.label : '';
            field.searchHint = source ? source.searchHint : '';
            field.multiple = !!f.multiple;
            field.maxItems = field.multiple ? pickSources.clampMaxItems(f.maxItems) : 1;
            // Whether the record's CONTENT travels into the run, or only its
            // title and id. Default on: "attach the transcript" is the whole
            // reason the field exists, and an author who only wants a reference
            // can switch it off per field.
            field.withText = f.withText === undefined ? true : !!f.withText;
        }
        if (FILE_FIELD_TYPES.includes(type)) {
            // Interpolated, because the author writes
            // `{{steps.<id>.output.fileId}}` — the id only exists once the run
            // has actually produced the document. Nothing is resolved here:
            // this module stays pure, and the ROUTE turns the id into a
            // filename, a size and a session-scoped href when it serves the
            // page (a field whose file is gone or expired is dropped there).
            field.required = false;
            field.fileId = typeof f.fileId === 'string' ? t(f.fileId).trim().slice(0, 200) : '';
        }
        out.push(field);
        if (!group) declared += 1;
        else if (f.groupHeader !== true) perGroup.set(group, (perGroup.get(group) || 0) + 1);
    }
    return out;
}

/** Normalized fields of a definition's form TRIGGER. */
function formTriggerFields(definition) {
    return normalizeFields(definition?.trigger?.form);
}

/**
 * Validate a form DECLARATION — used at save time for both the trigger's
 * `trigger.form` and a form_page step's `step.form`.
 *
 * `requireFields: false` is the summary/ending page: it shows text and has
 * nothing to submit, so zero fields is the normal case rather than an
 * unfinished one.
 *
 * `allowDisplayFields: false` rejects download/notebook buttons (no file exists
 * yet on the first page) and, unless `allowInfo` says otherwise, info blocks.
 * `allowRunData: true` (a form_page step only) lets choices and questions come
 * from earlier steps (optionsFrom / fieldsFrom).
 *
 * Returns issue records `[{ code, path, message, hint }]`; empty = valid.
 */
function validateFormDeclaration(form, /** @type {{requireFields?: boolean, allowDisplayFields?: boolean, allowRunData?: boolean, allowInfo?: boolean}} */ { requireFields = true, allowDisplayFields = true, allowRunData = false, allowInfo } = {}) {
    const infoOk = allowInfo ?? allowDisplayFields;
    const issues = [];
    const push = (code, path, message, hint) => issues.push({ code, path, message, hint });

    if (form === undefined || form === null) {
        // A freshly-dropped node has no form yet — a completeness problem, not
        // a shape error. validate.js downgrades this code at draft stage.
        push('incomplete', 'form',
            requireFields ? 'This form has no fields yet — nobody can submit it.' : 'This page has no content yet.',
            requireFields ? 'Open the step and add at least one field.' : 'Open the step and write the message visitors should see.');
        return issues;
    }
    if (!isPlainObject(form)) {
        push('shape', 'form', 'form must be an object.', 'Re-create the node.');
        return issues;
    }

    for (const [key, max] of /** @type {Array<[string, number]>} */ ([['title', MAX_LABEL_LEN], ['description', MAX_TEXT_LEN], ['submitLabel', MAX_LABEL_LEN], ['successMessage', MAX_TEXT_LEN]])) {
        const v = form[key];
        if (v !== undefined && (typeof v !== 'string' || v.length > max)) {
            push(`${key}_invalid`, `form.${key}`, `${key} must be text of at most ${max} characters.`, 'Shorten it.');
        }
    }

    for (const issue of validateTheme(form.theme, 'form.theme')) {
        push(issue.code, issue.path, issue.message, issue.hint);
    }

    // "Collect the answers in a table" is a yes/no on the trigger's form
    // (automation/formAnswers reads it); anything else is a shape error.
    if (form.collect !== undefined && typeof form.collect !== 'boolean') {
        push('collect_invalid', 'form.collect', 'collect must be true or false.', 'Switch "Collect answers in a table" on or off.');
    }

    // A missing `fields` key is "no questions yet", not a malformed shape — it
    // is what a freshly-dropped node looks like, and `fields_shape` is an
    // integrity code that would make that node unsavable even as a draft. Only
    // a present-but-not-an-array value is a real shape error.
    const fields = form.fields === undefined ? [] : form.fields;
    if (!Array.isArray(fields)) {
        push('fields_shape', 'form.fields', 'form.fields must be an array of field definitions.', 'Add the fields visitors should fill in.');
        return issues;
    }
    if (fields.length === 0 && requireFields) {
        push('incomplete', 'form.fields', 'This form has no fields yet — nobody can submit it.', 'Add at least one field.');
    }
    if (fields.length > MAX_FIELDS) {
        push('fields_too_many', 'form.fields', `Too many fields: ${fields.length} > ${MAX_FIELDS}.`, 'Split the form, or drop the fields you do not act on.');
    }

    const seen = new Set();
    const earlier = new Set();   // input fields declared above, for showIf
    fields.forEach((f, i) => {
        const at = `form.fields[${i}]`;
        if (!isPlainObject(f)) { push('field_shape', at, 'Each field must be an object.', 'Remove the malformed entry.'); return; }
        if (typeof f.name !== 'string' || !PARAM_NAME_RE.test(f.name)) {
            push('field_name', `${at}.name`, `Field name "${f.name}" is invalid.`, 'Use a letter followed by letters/digits/underscores (max 60 chars); names may not start with "_".');
        } else if (seen.has(f.name)) {
            push('field_name_duplicate', `${at}.name`, `Field name "${f.name}" is duplicated.`, 'Every field needs a unique name — it is how you bind trigger.output.<name>.');
        } else {
            seen.add(f.name);
            // nosemgrep: ajinabraham.njsscan.dos.regex_dos.regex_dos -- RESERVED_NAME_RE is /__\d+$/ on a field name: a literal prefix and one repeat, linear
            if (RESERVED_NAME_RE.test(f.name)) {
                push('field_name_reserved', `${at}.name`, `Field name "${f.name}" ends in two underscores and a number, which Bee Flow uses for questions it creates itself.`, 'Rename the field, e.g. without the trailing "__<number>".');
            }
        }
        if (f.type !== undefined && !FIELD_TYPES.includes(f.type)) {
            push('field_type', `${at}.type`, `Field type "${f.type}" is not supported.`, `Use one of: ${FIELD_TYPES.join(', ')}.`);
        }
        if (f.label !== undefined && (typeof f.label !== 'string' || f.label.length > MAX_LABEL_LEN)) {
            push('field_label', `${at}.label`, `label must be text of at most ${MAX_LABEL_LEN} characters.`, 'Shorten the label.');
        }
        if (f.required !== undefined && typeof f.required !== 'boolean') {
            push('field_required', `${at}.required`, 'required must be a boolean.', 'Remove the field or set true/false.');
        }
        validateChoices(f, at, allowRunData, push);
        validateInfo(f, at, infoOk, push);
        validateFileKinds(f, at, allowDisplayFields, push);
        rules.validateRules(f, at, push);
        if (f.showIf !== undefined && f.showIf !== null && f.showIf !== '') rules.validateShowIf(f.showIf, earlier, `${at}.showIf`, push);
        if (f.fieldsFrom !== undefined && f.fieldsFrom !== null) {
            dynamic.validateSourceSpec(f.fieldsFrom, `${at}.fieldsFrom`, push, { allowRunData, kind: 'fieldsFrom', field: f });
        }
        if (typeof f.name === 'string' && !isDisplayField(f)) earlier.add(f.name);
    });
    return issues;
}

/** Choice questions: static options, the cap, and an optionsFrom source. */
function validateChoices(f, at, allowRunData, push) {
    const hasSource = f.optionsFrom !== undefined && f.optionsFrom !== null;
    if (hasSource) {
        if (isChoiceField(f)) dynamic.validateSourceSpec(f.optionsFrom, `${at}.optionsFrom`, push, { allowRunData, kind: 'optionsFrom' });
        else push('field_options_from_invalid', `${at}.optionsFrom`, `Choices from a list only apply to dropdowns, radio buttons and multi-selects, not "${f.name}".`, 'Remove it, or change the question type.');
    }
    if (!isChoiceField(f)) return;
    const cap = formOptionsCap();
    if (Array.isArray(f.options) && cap > 0 && f.options.length > cap) {
        push('field_options_too_many', `${at}.options`, `"${f.name}" offers ${f.options.length} choices, more than the ${cap} a question may have.`, 'Remove some, or load the choices from a list on a later Form page step.');
    }
    if (!hasSource && normalizeOptions(f.options).length === 0) {
        const what = f.type === 'select' ? 'The dropdown' : (f.type === 'radio' ? 'The radio buttons' : 'The multi-select');
        push('field_options', `${at}.options`, `${what} "${f.name}" has no choices.`, 'Add at least one option, or use a text field instead.');
    }
}

/** Info blocks: some text, within limits, and only where display fields are allowed. */
function validateInfo(f, at, infoOk, push) {
    if (f.type !== 'info') return;
    if (!infoOk) push('field_type', `${at}.type`, 'A text block cannot be used on this form.', 'Use a question type instead.');
    if (typeof f.content !== 'string' || !f.content.trim()) {
        push('field_info_empty', `${at}.content`, `The text block "${f.name}" has no text.`, 'Write the text visitors should read, or remove the block.');
    } else if (f.content.length > MAX_INFO_LEN) {
        push('field_info_too_long', `${at}.content`, `The text block "${f.name}" is longer than ${MAX_INFO_LEN} characters.`, 'Shorten it.');
    }
}

/** File-backed display fields, app pickers and uploads (unchanged rules). */
function validateFileKinds(f, at, allowDisplayFields, push) {
    if (FILE_FIELD_TYPES.includes(f.type)) {
        const what = f.type === 'notebook' ? 'An "Open in Notebooks" button' : 'A download button';
        if (!allowDisplayFields) {
            // The trigger page is served before any run exists, so there is
            // no document to point at and never will be on THIS page.
            push('field_download_on_trigger', `${at}.type`, `${what} cannot go on the first page of a form.`, 'The file has to be made first — put it on a later Form page step, after the step that makes the document.');
        }
        if (typeof f.fileId !== 'string' || !f.fileId.trim()) {
            // One code for both: the authoring gap is identical, and
            // validate.js already lists it as a completeness warning so a
            // half-built page still saves.
            push('field_download_no_file', `${at}.fileId`, `"${f.name}" does not say which file to offer.`, 'Point it at the step that makes the document, e.g. {{steps.<id>.output.fileId}}.');
        }
    }
    if (f.type === 'app_pick') {
        if (typeof f.source !== 'string' || !f.source.trim()) {
            push('field_pick_no_source', `${at}.source`, `"${f.name}" does not say which app to pick from.`, `Choose an app for this question, e.g. ${pickSources.SOURCE_IDS[0]}.`);
        } else if (!pickSources.getSource(f.source)) {
            // Named, not silently reset to a default: an author who typed
            // the wrong id (or imported an automation from an install with an
            // app this one does not have) must see WHICH app is missing.
            push('field_pick_source', `${at}.source`, `"${f.source}" is not an app this form can pick from.`, `Use one of: ${pickSources.SOURCE_IDS.join(', ')}.`);
        }
        if (f.maxItems !== undefined) {
            const n = Number(f.maxItems);
            if (!Number.isFinite(n) || n < 1 || n > pickSources.MAX_PICKS) {
                push('field_pick_max_items', `${at}.maxItems`, `maxItems must be a number between 1 and ${pickSources.MAX_PICKS}.`, 'Lower it, or ask for one record per question.');
            }
        }
    }
    if (f.type === 'file' && f.maxSizeMb !== undefined) {
        const mb = Number(f.maxSizeMb);
        if (!Number.isFinite(mb) || mb <= 0 || mb > MAX_UPLOAD_MB) {
            push('field_max_size', `${at}.maxSizeMb`, `maxSizeMb must be a number between 1 and ${MAX_UPLOAD_MB}.`, `The platform ceiling is ${MAX_UPLOAD_MB} MB.`);
        }
    }
}

/**
 * The subset of a form declaration the PUBLIC page is allowed to see. Built
 * from the normalized fields, so nothing an author typed into an unknown key
 * can leak, and the theme is always complete.
 *
 * Options:
 *   • `interpolate` — a `(string) => string` template renderer. A form_page
 *     step passes one so `{{steps.x.output.y}}` in the page's text resolves
 *     against the paused run; the trigger's own page never does, because at GET
 *     time there is no run yet. The interpolator is responsible for masking
 *     secrets — this config is served to an anonymous visitor.
 *   • `baseTheme` — the theme to inherit. A form_page step passes the trigger's
 *     theme so page 2 looks identical unless the author deliberately overrides
 *     it; a partial override merges on top.
 *   • `resolveList` — `(ref) => value`, a read of the run state. With it,
 *     `optionsFrom` becomes plain options and `fieldsFrom` becomes one
 *     question per item. The output NEVER contains either spec, and strings
 *     that come out of run data are not interpolated again.
 */
function renderFormConfig(form, { interpolate = null, baseTheme = null, resolveList = null } = {}) {
    const f = isPlainObject(form) ? form : {};
    const t = makeInterpolator(interpolate);
    const title = typeof f.title === 'string' ? t(f.title).trim() : '';
    const submitLabel = typeof f.submitLabel === 'string' ? t(f.submitLabel).trim() : '';
    const successMessage = typeof f.successMessage === 'string' ? t(f.successMessage).trim() : '';
    const theme = isPlainObject(f.theme)
        ? { ...(isPlainObject(baseTheme) ? baseTheme : {}), ...f.theme }
        : baseTheme;
    return {
        title: title ? title.slice(0, MAX_LABEL_LEN) : 'Form',
        description: typeof f.description === 'string' ? t(f.description).slice(0, MAX_RENDERED_DESCRIPTION_LEN) : '',
        submitLabel: submitLabel ? submitLabel.slice(0, MAX_LABEL_LEN) : 'Submit',
        successMessage: successMessage ? successMessage.slice(0, MAX_TEXT_LEN) : 'Thanks — we got your answer.',
        theme: canonicalizeTheme(theme),
        fields: renderDynamicFields(normalizeFields(f, { interpolate }), resolveList),
    };
}

/** Replace optionsFrom / fieldsFrom by what the run data says (or by nothing to choose). */
function renderDynamicFields(fields, resolveList) {
    const out = [];
    for (const field of fields) {
        if (!isDynamicField(field)) { out.push(field); continue; }
        const { optionsFrom, fieldsFrom, ...rest } = field;
        if (fieldsFrom) {
            out.push(...dynamic.expandFieldsFrom(rest, fieldsFrom, resolveList));
            continue;
        }
        const options = dynamic.resolveOptions(optionsFrom, resolveList);
        out.push(options.length ? { ...rest, options } : { ...rest, options: [], noOptions: true, required: false });
    }
    return out;
}

/** Render config for a definition's form TRIGGER (the first page). */
function renderConfig(definition) {
    return renderFormConfig(definition?.trigger?.form);
}

/**
 * The EMPTY sample for a form: every declared field name, each holding the
 * value a submission that answered nothing would carry.
 *
 * The builder needs it for the "start from empty answers" button on a form
 * trigger: a payload whose keys are the form's, so bindings resolve while the
 * author is still filling them in. Writing a second field-walker to produce it
 * would have been the mistake: the two would agree
 * on the day they were written and drift on every field type added afterwards,
 * and the whole value of the sample is that it has the same shape a real
 * submission does.
 *
 * So it is not a new walker. It is coerceSubmission — the SAME function the
 * public submit endpoint runs every visitor answer through — fed an empty body.
 * Every rule about which fields collect a value, and what an unanswered one of
 * each type looks like (false for a checkbox, null for a file, empty string for
 * the rest), is therefore answered in exactly one place. Shape parity is
 * guaranteed by construction rather than by remembering.
 *
 * The submission `errors` list is deliberately dropped: required fields report as
 * missing here, which is correct for a real submission and meaningless for a
 * blank sample.
 */
function emptyFormValues(form) {
    return coerceSubmission(normalizeFields(form), {}).values;
}

/**
 * Back-compat alias: the trigger's declaration always requires fields, and
 * never allows file buttons — the first page is served before any run exists,
 * so there is no document for a download button to point at. A text block is
 * fine there: it needs nothing from a run.
 */
function validateFormTrigger(form) {
    return validateFormDeclaration(form, { requireFields: true, allowDisplayFields: false, allowInfo: true });
}

module.exports = {
    FIELD_TYPES,
    DISPLAY_FIELD_TYPES,
    FILE_FIELD_TYPES,
    CHOICE_FIELD_TYPES,
    RESERVED_NAME_RE,
    isFileField,
    isDisplayField,
    isDynamicField,
    MAX_FIELDS,
    MAX_UPLOAD_MB,
    DEFAULT_UPLOAD_MB,
    formOptionsCap,
    formFieldsFromCap,
    isFormTriggerDefinition,
    normalizeFields,
    formTriggerFields,
    validateFormDeclaration,
    validateFormTrigger,
    renderFormConfig,
    renderConfig,
    emptyFormValues,
    coerceFieldValue,
    coerceSubmission,
    isPickField,
    MAX_RENDERED_DESCRIPTION_LEN,
};

/**
 * @typedef {{ theme?: object, collect?: unknown, fields?: unknown, [key: string]: unknown }} FormDeclaration
 *   a form as an author wrote it (trigger.form or a form_page step's form)
 * @typedef {{ type: string, optionsFrom?: unknown, fieldsFrom?: unknown } & Record<string, any>} FormField   one declared (or normalized) question: loose authored JSON
 * @typedef {(code: string, path: string, message: string, hint: string) => unknown} IssuePush   collects one validation issue
 * @typedef {{ code: string, path: string, message: string, hint: string }} FormIssue
 * @typedef {(s: string) => string} Interpolator
 */
