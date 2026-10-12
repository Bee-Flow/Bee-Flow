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

const { PARAM_NAME_RE, MAX_STRING_VALUE } = require('./appTriggerContract');
const { canonicalizeTheme, validateTheme } = require('../core/cms/themeSpec');
const pickSources = require('./formPickSources');

const FIELD_TYPES = Object.freeze(['text', 'textarea', 'email', 'number', 'date', 'select', 'checkbox', 'file', 'app_pick', 'download', 'notebook']);

/**
 * Field types that DISPLAY something instead of collecting it.
 *
 * Both of today's two hand the visitor a file a `generate_document` or
 * `fill_document` step produced: `download` saves it, `notebook` opens it in Notebooks. They live in
 * `fields` because that is where a form's page furniture already is, but every
 * input-shaped code path has to step over them — they are never submitted,
 * never required, never coerced, and have no initial value. Treating one as an
 * input would make a form with a download button on it permanently
 * un-submittable.
 */
const DISPLAY_FIELD_TYPES = Object.freeze(['download', 'notebook']);
const isDisplayField = (f) => DISPLAY_FIELD_TYPES.includes(f?.type);

/**
 * Display fields that point at a generated file by id. Same shape, same
 * authoring slot, same "the route resolves it" rule — only the button differs.
 */
const FILE_FIELD_TYPES = Object.freeze(['download', 'notebook']);
const isFileField = (f) => FILE_FIELD_TYPES.includes(f?.type);

/** A question answered by picking a record in an app the FILLER has access to. */
const isPickField = (f) => f?.type === 'app_pick';

const MAX_FIELDS = 40;
const MAX_LABEL_LEN = 120;
const MAX_TEXT_LEN = 2000;          // title / description / successMessage, as AUTHORED
// A description is the one text on a form page that routinely carries
// INTERPOLATED run output — a closing page whose whole job is to show what the
// automation produced ("here is your document, and here is the text"). The
// authored template stays bounded by MAX_TEXT_LEN above (it is only a few
// {{refs}}); what it renders TO is bounded separately and far higher, or the
// page silently truncates the result mid-sentence at 2000 characters.
const MAX_RENDERED_DESCRIPTION_LEN = 20000;
const MAX_PLACEHOLDER_LEN = 120;
const MAX_OPTIONS = 50;
const MAX_OPTION_LEN = 120;
// Server-side ceiling on a per-field `maxSizeMb`. uploadGuard's own default is
// 25MB; a form author may lower it but never raise it past this.
const MAX_UPLOAD_MB = 25;
const DEFAULT_UPLOAD_MB = 10;
// A textarea is the one field where a long answer is the point.
const MAX_TEXTAREA_LEN = 20000;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function isPlainObject(v) {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** True when a definition's PRIMARY trigger is a form trigger. */
function isFormTriggerDefinition(definition) {
    return definition?.trigger?.kind === 'form';
}

function normalizeOptions(raw) {
    if (!Array.isArray(raw)) return [];
    const out = [];
    for (const o of raw) {
        // Both `["Sales","Support"]` and `[{value,label}]` are accepted; the
        // builder writes plain strings, the AI builder sometimes writes objects.
        const value = typeof o === 'string' ? o : (isPlainObject(o) ? o.value : null);
        if (typeof value !== 'string' || !value.trim()) continue;
        const label = isPlainObject(o) && typeof o.label === 'string' && o.label.trim() ? o.label : value;
        out.push({ value: value.slice(0, MAX_OPTION_LEN), label: label.slice(0, MAX_OPTION_LEN) });
        if (out.length >= MAX_OPTIONS) break;
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
    for (const f of raw) {
        if (!isPlainObject(f)) continue;
        if (typeof f.name !== 'string' || !PARAM_NAME_RE.test(f.name) || seen.has(f.name)) continue;
        seen.add(f.name);
        const type = FIELD_TYPES.includes(f.type) ? f.type : 'text';
        const label = typeof f.label === 'string' ? t(f.label).trim() : '';
        const field = {
            name: f.name,
            type,
            label: label ? label.slice(0, MAX_LABEL_LEN) : f.name,
            required: !!f.required,
            placeholder: typeof f.placeholder === 'string' ? t(f.placeholder).slice(0, MAX_PLACEHOLDER_LEN) : '',
            help: typeof f.help === 'string' ? t(f.help).slice(0, MAX_PLACEHOLDER_LEN) : '',
        };
        if (type === 'select') {
            field.options = normalizeOptions(f.options).map(o => ({ value: o.value, label: t(o.label).slice(0, MAX_OPTION_LEN) || o.value }));
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
        if (out.length >= MAX_FIELDS) break;
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
 * Returns issue records `[{ code, path, message, hint }]`; empty = valid.
 */
function validateFormDeclaration(form, { requireFields = true, allowDisplayFields = true } = {}) {
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

    for (const [key, max] of [['title', MAX_LABEL_LEN], ['description', MAX_TEXT_LEN], ['submitLabel', MAX_LABEL_LEN], ['successMessage', MAX_TEXT_LEN]]) {
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
    fields.forEach((f, i) => {
        const at = `form.fields[${i}]`;
        if (!isPlainObject(f)) { push('field_shape', at, 'Each field must be an object.', 'Remove the malformed entry.'); return; }
        if (typeof f.name !== 'string' || !PARAM_NAME_RE.test(f.name)) {
            push('field_name', `${at}.name`, `Field name "${f.name}" is invalid.`, 'Use a letter followed by letters/digits/underscores (max 60 chars); names may not start with "_".');
        } else if (seen.has(f.name)) {
            push('field_name_duplicate', `${at}.name`, `Field name "${f.name}" is duplicated.`, 'Every field needs a unique name — it is how you bind trigger.output.<name>.');
        } else {
            seen.add(f.name);
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
        if (f.type === 'select' && normalizeOptions(f.options).length === 0) {
            push('field_options', `${at}.options`, `The dropdown "${f.name}" has no choices.`, 'Add at least one option, or use a text field instead.');
        }
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
    });
    return issues;
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
 */
function renderFormConfig(form, { interpolate = null, baseTheme = null } = {}) {
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
        fields: normalizeFields(f, { interpolate }),
    };
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

/** Type-check/coerce ONE submitted value. `{ ok, value }` or `{ ok:false, error }`. */
function coerceFieldValue(field, raw) {
    switch (field.type) {
        case 'textarea': {
            if (typeof raw !== 'string') return { ok: false, error: 'expects text' };
            return { ok: true, value: raw.slice(0, MAX_TEXTAREA_LEN) };
        }
        case 'text': {
            if (typeof raw !== 'string') return { ok: false, error: 'expects text' };
            return { ok: true, value: raw.slice(0, MAX_STRING_VALUE) };
        }
        case 'email': {
            if (typeof raw !== 'string') return { ok: false, error: 'expects an email address' };
            const v = raw.trim();
            if (v && !EMAIL_RE.test(v)) return { ok: false, error: 'is not a valid email address' };
            return { ok: true, value: v.slice(0, MAX_STRING_VALUE) };
        }
        case 'number': {
            if (typeof raw === 'number' && Number.isFinite(raw)) return { ok: true, value: raw };
            if (typeof raw === 'string' && raw.trim() !== '' && Number.isFinite(Number(raw))) return { ok: true, value: Number(raw) };
            return { ok: false, error: 'expects a number' };
        }
        case 'date': {
            if (typeof raw !== 'string') return { ok: false, error: 'expects a date (YYYY-MM-DD)' };
            const v = raw.trim();
            if (v && !DATE_RE.test(v)) return { ok: false, error: 'expects a date in YYYY-MM-DD format' };
            return { ok: true, value: v };
        }
        case 'select': {
            if (typeof raw !== 'string') return { ok: false, error: 'expects one of the offered choices' };
            const v = raw.trim();
            if (!v) return { ok: true, value: '' };
            // Closed vocabulary: an off-list value is a tampered submission.
            if (!(field.options || []).some(o => o.value === v)) return { ok: false, error: 'is not one of the offered choices' };
            return { ok: true, value: v };
        }
        case 'checkbox': {
            if (typeof raw === 'boolean') return { ok: true, value: raw };
            if (raw === 'true' || raw === 'on' || raw === 1 || raw === '1') return { ok: true, value: true };
            if (raw === 'false' || raw === 'off' || raw === 0 || raw === '0' || raw === '') return { ok: true, value: false };
            return { ok: false, error: 'expects a yes/no answer' };
        }
        case 'file': {
            let v = raw;
            if (Array.isArray(v)) {
                if (v.length === 1) v = v[0];
                else return { ok: false, error: 'expects one file' };
            }
            if (!isPlainObject(v) || v.kind !== 'form_upload' || typeof v.fileId !== 'string' || !v.fileId) {
                return { ok: false, error: 'expects a file uploaded through this form' };
            }
            return { ok: true, isFile: true, value: { kind: 'form_upload', fileId: v.fileId } };
        }
        case 'app_pick': {
            // The DECLARED source decides what may be picked; a body naming a
            // different one is a tampered submission, not a hint. Without this
            // check a form asking for a Fireflies transcript would accept —
            // and then dutifully read — a Gmail message id.
            const declared = pickSources.getSource(field.source);
            if (!declared) return { ok: false, error: 'points at an app that is not available' };
            const list = Array.isArray(raw) ? raw : [raw];
            if (list.length === 1 && (list[0] === null || list[0] === '')) return { ok: true, value: field.multiple ? [] : null };
            if (list.length > field.maxItems) return { ok: false, error: `takes at most ${field.maxItems} ${field.maxItems === 1 ? 'record' : 'records'}` };
            const picks = [];
            const seen = new Set();
            for (const v of list) {
                if (!isPlainObject(v) || v.kind !== 'app_pick') return { ok: false, error: 'expects a record picked through this form' };
                if (typeof v.source === 'string' && v.source && v.source !== field.source) {
                    return { ok: false, error: 'expects a record from the app this question asks for' };
                }
                const recordId = typeof v.recordId === 'string' ? v.recordId.trim() : '';
                if (!recordId || recordId.length > pickSources.MAX_RECORD_ID_LEN) {
                    return { ok: false, error: 'expects a record picked through this form' };
                }
                if (seen.has(recordId)) continue;   // the same record twice is one pick
                seen.add(recordId);
                picks.push({
                    kind: 'app_pick',
                    source: field.source,
                    app: declared.app,
                    recordId,
                    // The title the picker showed. Carried so a run that cannot
                    // re-read the record still knows WHAT was chosen; replaced
                    // by the record's own title when the read succeeds.
                    title: typeof v.title === 'string' ? v.title.slice(0, pickSources.MAX_TITLE_LEN) : '',
                });
            }
            return { ok: true, isPick: true, value: field.multiple ? picks : (picks[0] || null) };
        }
        default:
            return { ok: false, error: `has unknown type "${field.type}"` };
    }
}

function isBlank(field, value) {
    if (field.type === 'checkbox') return value !== true;
    if (field.type === 'file') return !value;
    if (field.type === 'app_pick') return Array.isArray(value) ? value.length === 0 : !value;
    if (field.type === 'number') return value === undefined || value === null || value === '';
    return typeof value !== 'string' || value.trim() === '';
}

/**
 * Coerce a whole submission against the declared fields.
 *
 * Returns `{ values, files, errors }`. `values` is a null-prototype object
 * keyed ONLY by declared field names — the body is never iterated, so
 * `{"__proto__": {...}}` in the request cannot reach it. `files` lists the
 * descriptors the caller still has to verify against the upload ledger.
 */
function coerceSubmission(fields, body) {
    const src = isPlainObject(body) ? body : {};
    const values = Object.create(null);
    const files = [];
    const picks = [];
    const errors = [];

    for (const field of fields) {
        // A display field collects nothing. It gets no entry in `values` at
        // all, so a browser that posts one back cannot smuggle a value into the
        // run under its name.
        if (isDisplayField(field)) continue;
        // Own-property read: a prototype-polluted global Object.prototype must
        // not be able to supply a value for a field the visitor left out.
        const raw = Object.prototype.hasOwnProperty.call(src, field.name) ? src[field.name] : undefined;

        if (raw === undefined || raw === null) {
            if (field.required) errors.push({ field: field.name, message: `${field.label} is required.` });
            values[field.name] = emptyValue(field);
            continue;
        }

        const checked = coerceFieldValue(field, raw);
        if (!checked.ok) {
            errors.push({ field: field.name, message: `${field.label} ${checked.error}.` });
            values[field.name] = emptyValue(field);
            continue;
        }
        if (field.required && isBlank(field, checked.value)) {
            errors.push({ field: field.name, message: `${field.label} is required.` });
        }
        values[field.name] = checked.value;
        if (checked.isFile && checked.value) files.push({ field: field.name, fileId: checked.value.fileId });
        if (checked.isPick) {
            // One entry per RECORD, not per field: a `multiple` question sends
            // the route several reads to do, and each one has to be able to
            // fail on its own without taking the others down with it.
            const chosen = Array.isArray(checked.value) ? checked.value : (checked.value ? [checked.value] : []);
            chosen.forEach((pick, index) => picks.push({ field: field.name, index, multiple: !!field.multiple, withText: field.withText !== false, pick }));
        }
    }

    return { values, files, picks, errors };
}

/**
 * What an unanswered field of each type carries into the run.
 *
 * One function rather than the two inline ternaries this replaced: the
 * "nothing was answered" value has to be the SAME on the missing-value path and
 * the failed-coercion path, and a third type made keeping two copies in step a
 * matter of remembering.
 */
function emptyValue(field) {
    if (field.type === 'checkbox') return false;
    if (field.type === 'file') return null;
    if (field.type === 'app_pick') return field.multiple ? [] : null;
    return '';
}

/**
 * Back-compat alias: the trigger's declaration always requires fields, and
 * never allows display-only ones — the first page is served before any run
 * exists, so there is no document for a download button to point at.
 */
function validateFormTrigger(form) {
    return validateFormDeclaration(form, { requireFields: true, allowDisplayFields: false });
}

module.exports = {
    FIELD_TYPES,
    DISPLAY_FIELD_TYPES,
    FILE_FIELD_TYPES,
    isFileField,
    isDisplayField,
    MAX_FIELDS,
    MAX_UPLOAD_MB,
    DEFAULT_UPLOAD_MB,
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
