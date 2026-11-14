// @typecheck
/**
 * `data_extraction`, the step that hands a text to a MODEL to pull fields out
 * of: the text it reads and the fields it extracts. The other model step,
 * `ai_step`, has its rules in aiStepRules.js.
 *
 * The question that drives both: which fields of this step's output does
 * anything downstream actually read (`ctx.fieldsReadFromStep`).
 */

const { isObject } = require('../helpers');
const { hasPlaceholder, isBareRefString } = require('../refPaths');
const {
    DATA_EXTRACTION_FIELD_TYPES, DATA_EXTRACTION_FIELD_NAME_RE,
    DATA_EXTRACTION_MAX_FIELDS, DATA_EXTRACTION_MAX_INSTRUCTIONS_CHARS,
} = require('../constants');

/**
 * @param {string} at
 */
function checkDataExtraction(ctx, step, at) {
    const { pushE, pushW, fieldsReadFromStep } = ctx;
    if (step.type === 'data_extraction') {
        // `source` is the text the model reads: a binding, never absent.
        // Missing — absent, blank, or the empty scaffold the palette drops
        // — is COMPLETENESS: the node lands before it is wired. A bare
        // STRING is tolerated by the runner (a `{{…}}` template or a
        // ref-looking path is resolved; anything else is read literally),
        // so it only warns; any other non-binding value is integrity —
        // the runner would serialise it and extract from the words.
        const src = step.source;
        const isBinding = isObject(src) && typeof src.kind === 'string' && ['ref', 'template', 'literal', 'expr'].includes(src.kind);
        const bindingBlank = isBinding && (
            (src.kind === 'ref' && !(typeof src.path === 'string' && src.path.trim()))
            || (src.kind !== 'ref' && !(typeof src.value === 'string' ? src.value.trim() : src.value !== undefined && src.value !== null))
        );
        const emptyScaffold = (isObject(src) && !isBinding && Object.keys(src).length === 0) || (typeof src === 'string' && !src.trim());
        if (src === undefined || src === null || bindingBlank || emptyScaffold) {
            pushE({ code: 'data_extraction.source_missing', severity: 'error', path: at + '.source', message: `Step ${step.id}: there is no text to read yet.`, hint: 'Bind `source` to the text an earlier step produced, e.g. {kind:"ref", path:"steps.read.output.content"} — or loop.<item>.output.content inside a fan-out.' });
        } else if (typeof src === 'string') {
            pushW({ code: 'data_extraction.source_bare_string', severity: 'warning', path: at + '.source', message: `Step ${step.id}: source is a bare string; it is read as a ${hasPlaceholder(src) ? 'template' : (isBareRefString(src) ? 'reference path' : 'LITERAL text, not a reference')}.`, hint: 'Prefer a binding: {kind:"ref", path:"steps.<id>.output.<field>"}.' });
        } else if (!isBinding) {
            pushE({ code: 'data_extraction.source_invalid', severity: 'error', path: at + '.source', message: `Step ${step.id}: source must be a binding ({kind:"ref", path:"…"}), not a bare value.`, hint: 'Point it at an upstream value: {kind:"ref", path:"steps.<id>.output.<field>"}.' });
        } else if (src.kind === 'ref' && /\.(path|fileId|file_id|size|modified|contentType|mimeType|href|url)\s*$/.test(src.path)) {
            // The builder saw a read step fail, dropped it, and pointed
            // the extraction at loop.f.path — the listing's file path —
            // and this validator passed it (2026-09-12). A path is a
            // location, not text: warn, so activation shows it.
            pushW({ code: 'data_extraction.source_is_location', severity: 'warning', path: at + '.source', message: `Step ${step.id}: source "${src.path.trim()}" is a file's location, not its text — the extraction model would read the words of a path.`, hint: 'Read the file first (e.g. nextcloud_read_file with forEach over the listing) and bind source to that step\'s content: loop.<item>.output.content.' });
        }
        // `fields` is the output shape — the names become `steps.<id>.
        // output.<name>` keys and later bindings, so they are held to a
        // plain-identifier pattern, kept unique, and typed from the enum.
        // An empty list is completeness (the palette seeds one blank row);
        // a bad name or type is integrity and blocks at every stage.
        const rows = Array.isArray(step.fields) ? step.fields : [];
        const namedRows = rows.filter(f => isObject(f) && typeof f.name === 'string' && f.name.trim());
        if (!Array.isArray(step.fields) || namedRows.length === 0) {
            pushE({ code: 'data_extraction.fields_missing', severity: 'error', path: at + '.fields', message: `Step ${step.id}: no fields to extract yet.`, hint: 'Add at least one field: a lowercase name (becomes the output key), a type (string, number, boolean, date) and what to look for.' });
        } else {
            if (rows.length > DATA_EXTRACTION_MAX_FIELDS) {
                pushE({ code: 'data_extraction.fields_too_many', severity: 'error', path: at + '.fields', message: `Step ${step.id}: ${rows.length} fields is more than the limit of ${DATA_EXTRACTION_MAX_FIELDS}.`, hint: 'Split the extraction over two steps, or drop the fields nothing downstream reads.' });
            }
            const seenNames = new Set();
            rows.forEach((f, i) => {
                if (!isObject(f)) {
                    pushE({ code: 'data_extraction.field_name_invalid', severity: 'error', path: `${at}.fields[${i}]`, message: `Step ${step.id}: field ${i + 1} is not a field object.`, hint: 'Each field is {name, type, description, required}.' });
                    return;
                }
                const name = typeof f.name === 'string' ? f.name.trim() : '';
                if (!name) {
                    // A blank row beside filled ones is the palette's seed row
                    // left over — still mid-typing, so completeness.
                    pushE({ code: 'data_extraction.fields_missing', severity: 'error', path: `${at}.fields[${i}].name`, message: `Step ${step.id}: field ${i + 1} has no name yet.`, hint: 'Name it (lowercase letters, digits and underscores) or remove the row.' });
                } else if (!DATA_EXTRACTION_FIELD_NAME_RE.test(name)) {
                    pushE({ code: 'data_extraction.field_name_invalid', severity: 'error', path: `${at}.fields[${i}].name`, message: `Step ${step.id}: "${name}" is not a valid field name.`, hint: 'Lowercase letters, digits and underscores, starting with a letter, at most 40 characters — e.g. invoice_date. It becomes the output key steps.<id>.output.<name>.' });
                } else if (seenNames.has(name)) {
                    pushE({ code: 'data_extraction.fields_duplicate', severity: 'error', path: `${at}.fields[${i}].name`, message: `Step ${step.id}: the field "${name}" is declared twice.`, hint: 'Every field name must be unique within the step — it is an output key.' });
                } else {
                    seenNames.add(name);
                }
                // Absent, null or blank reads as `string` everywhere (the
                // palette's seed row, an older import); only a VALUE that
                // is not a type is refused.
                if (f.type !== undefined && f.type !== null && f.type !== '' && !DATA_EXTRACTION_FIELD_TYPES.has(f.type)) {
                    pushE({ code: 'data_extraction.field_type_invalid', severity: 'error', path: `${at}.fields[${i}].type`, message: `Step ${step.id}: "${f.type}" is not a field type.`, hint: `Use one of: ${[...DATA_EXTRACTION_FIELD_TYPES].join(', ')}. A date is written as YYYY-MM-DD.` });
                }
            });
            // A downstream step reading a field this step never declares
            // gets null forever. Warn — the author may still be adding it.
            if (seenNames.size) {
                const undeclared = fieldsReadFromStep(step.id).all.filter(f => !seenNames.has(f));
                if (undeclared.length) {
                    pushW({ code: 'data_extraction.field_not_declared', severity: 'warning', path: at + '.fields', message: `Step ${step.id}: later steps read ${undeclared.map(f => `\`${f}\``).join(', ')} from this step, but it does not extract ${undeclared.length > 1 ? 'those fields' : 'that field'}.`, hint: 'Add the field here, or point the downstream binding at one of the declared fields.' });
                }
            }
        }
        if (step.instructions !== undefined && step.instructions !== null) {
            if (typeof step.instructions !== 'string') {
                pushE({ code: 'data_extraction.instructions_too_long', severity: 'error', path: at + '.instructions', message: `Step ${step.id}: instructions must be text.`, hint: 'A short note for the model, e.g. "Amounts are in euros."' });
            } else if (step.instructions.length > DATA_EXTRACTION_MAX_INSTRUCTIONS_CHARS) {
                pushE({ code: 'data_extraction.instructions_too_long', severity: 'error', path: at + '.instructions', message: `Step ${step.id}: instructions are ${step.instructions.length} characters; the limit is ${DATA_EXTRACTION_MAX_INSTRUCTIONS_CHARS}.`, hint: 'Keep it to the few things the model would otherwise get wrong — units, language, which of two similar dates.' });
            }
        }
    }
}

module.exports = { checkDataExtraction };
