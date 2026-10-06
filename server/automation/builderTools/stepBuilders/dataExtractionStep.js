/**
 * Builder tools — builder_add_data_extraction: the declared fields, the ONE
 * binding it reads its text from, and every foreign vocabulary the step
 * arrives in (inputs-wrapped, ai_step prompt/outputSchema, a source standing
 * in as a placeholder) translated into the one shape the runner reads.
 */

const { newId, appendAfter } = require('../draftGraph');
const { validateAndFixBindings, sanitizeForEach, unboundLoopVarError } = require('../bindings');
const { checkLoopRef } = require('../outputFields');
const { canonicalAiPath, hasPlaceholder, placeholdersOf } = require('../aiPaths');
const { replaceTemplate } = require('../../expr');
const { refHead, REF_ROOTS } = require('../../validate/refPaths');
const {
    DATA_EXTRACTION_FIELD_TYPES, DATA_EXTRACTION_FIELD_NAME_RE,
    DATA_EXTRACTION_MAX_FIELDS, DATA_EXTRACTION_MAX_INSTRUCTIONS_CHARS,
} = require('../../validate/constants');
const { listNames, LIST_TOOL_RX, fileLocationField } = require('./inputBindings');

// ── data_extraction ─────────────────────────────────────

/**
 * The declared fields of a data_extraction step, in the exact shape the
 * validator passes and the runner reads — so a patched step and a freshly
 * added one are the same object. Returns `{ fields }` or a model-readable
 * `{ error }` naming the row, so the LLM self-corrects on the next turn.
 *
 * The rules are the validator's (validate/constants.js): a lowercase-snake
 * name (it becomes the output key `steps.<id>.output.<name>`), unique within
 * the step, a type from the four, 1..30 rows. Order is preserved.
 */
function sanitizeDataExtractionFields(raw) {
    if (!Array.isArray(raw) || raw.length === 0) {
        return { error: 'fields is required — a non-empty array of {name, type, description, required?}, e.g. [{name:"datum", type:"date", description:"Invoice date", required:true}].' };
    }
    if (raw.length > DATA_EXTRACTION_MAX_FIELDS) return { error: `fields: max ${DATA_EXTRACTION_MAX_FIELDS} entries. Split the extraction over two steps.` };
    const seen = new Set();
    const fields = [];
    for (let i = 0; i < raw.length; i++) {
        const f = raw[i];
        if (!f || typeof f !== 'object' || Array.isArray(f)) return { error: `fields[${i}]: must be an object {name, type, description, required?}.` };
        const name = typeof f.name === 'string' ? f.name.trim() : '';
        if (!name) return { error: `fields[${i}]: name is required.` };
        if (!DATA_EXTRACTION_FIELD_NAME_RE.test(name)) {
            return { error: `fields[${i}]: "${name}" is not a valid field name. Use lowercase letters, digits and underscores, starting with a letter, max 40 chars (e.g. "invoice_date") — it becomes the output key steps.<id>.output.<name>.` };
        }
        if (seen.has(name)) return { error: `fields[${i}]: "${name}" is declared twice — every field name must be unique within the step.` };
        seen.add(name);
        const type = f.type === undefined || f.type === null || f.type === '' ? 'string' : f.type;
        if (!DATA_EXTRACTION_FIELD_TYPES.has(type)) {
            return { error: `fields[${i}]: unknown type "${type}". Use one of: ${[...DATA_EXTRACTION_FIELD_TYPES].join(', ')} (date = YYYY-MM-DD).` };
        }
        fields.push({
            name,
            type,
            description: typeof f.description === 'string' ? f.description.trim() : '',
            required: f.required === true,
        });
    }
    return { fields };
}

/**
 * The text a data_extraction step reads: ONE binding, canonicalised through
 * the same repair pass every input gets (bare "{{…}}" → template, a
 * kind-less {path} → ref, a mis-rooted trigger field → trigger.output.<f>).
 * A bare ref-looking string is upgraded to a ref rather than frozen as the
 * literal words "steps.x.output.y".
 */
function sanitizeDataExtractionSource(raw, draft, draftWrap) {
    if (raw === undefined || raw === null || raw === '') {
        return {
            error: 'source is required — bind it to the text to read, at the TOP LEVEL of the step (a data_extraction has no inputs map), e.g. source:{kind:"ref", path:"steps.read.output.content"} (or loop.<itemVar>.output.content inside a forEach).',
            // Without its own hint applyToolCall stamps "invalid input
            // binding" on this — there is no binding to fix, there is none.
            _fixHint: 'Reject reason: no source. Add source:{kind:"ref", path:"…"} at the top level of this step and resend it — the fields were fine.',
        };
    }
    let candidate = raw;
    if (typeof raw === 'string' && !hasPlaceholder(raw)) {
        // A data root followed by a segment (`steps.x…`, `steps["x"]…`), read
        // with the runner's grammar.
        const t = raw.trim();
        const { root } = refHead(t);
        if (root && REF_ROOTS.has(root) && (t[root.length] === '.' || t[root.length] === '[')) candidate = { kind: 'ref', path: t };
    }
    const { inputs, error, notes } = validateAndFixBindings({ source: candidate }, draft, { draftWrap });
    if (error) return { error: error.replace(/inputs\.source/g, 'source') };
    const source = inputs.source;
    if (source && source.kind === 'literal') {
        return { error: 'source must reference upstream text, not a literal value — use {kind:"ref", path:"steps.<id>.output.<field>"} or a {{…}} template.' };
    }
    const where = fileLocationField(source);
    if (where) {
        const head = refHead(where);
        const v = head.root === 'loop' && head.second ? head.second : 'f';
        return {
            error: `source is bound to "${where}" — that is the file's LOCATION, not its text; the extraction model would read the words of a path. Read the file first: an integration_action (e.g. nextcloud_read_file) with path:{kind:"ref",path:"${where}"} and forEach over the listing, then bind this step's source to loop.${v}.output.content with forEach over THAT step's output.results.`,
            _fixHint: 'Reject reason: source points at a file path instead of file text. Add the read step and bind source to its content — the fields were fine.',
        };
    }
    return { source, notes: (notes || []).map(n => n.replace(/^inputs\.source/, 'source')) };
}

// The path a placeholder holds, in the one spelling bindings.js stores
// (aiPaths.js — brackets kept): two placeholders that differ only in
// spelling ({{ $loop.f.content }} and {{loop.f.content}}) are ONE candidate.
function normalizePlaceholderPath(path) {
    if (typeof path !== 'string') return null;
    const p = canonicalAiPath(path.trim().replace(/^\$+/, ''));
    return p || null;
}

/**
 * The source a data_extraction did not set, read off its prompt.
 *
 * Measured 2026-09-12: the fast local model wrote the ai_step shape — a
 * prompt with `{{loop.f.content}}` standing in for the text — and no
 * `source`. "source is required" was answered with the byte-identical
 * batch three rounds running: to the model the text WAS bound, in the
 * prompt. One distinct placeholder is not a guess, so it becomes the source
 * (with a note); several are a real ambiguity and are refused with the
 * choice spelled out; none is the caller's plain "source is required".
 *
 * @returns {{source: object, note: string} | {error: string, _fixHint: string} | null}
 */
function deriveDataExtractionSource({ promptRefs, forEach } = {}) {
    const distinct = [];
    for (const raw of Array.isArray(promptRefs) ? promptRefs : []) {
        const p = normalizePlaceholderPath(raw);
        if (p && !distinct.includes(p)) distinct.push(p);
    }
    if (!distinct.length) return null;
    if (distinct.length === 1) {
        const path = distinct[0];
        return {
            source: { kind: 'ref', path },
            note: `source was not set — derived from the one placeholder {{${path}}} in the prompt (the prompt is not where the text is bound). Set source:{kind:"ref", path:"${path}"} explicitly next time.`,
        };
    }
    // The example is the candidate most likely to be the text: the one under
    // this step's own loop var, else simply the first.
    const own = forEach && typeof forEach.itemVar === 'string' ? distinct.find(p => p.startsWith(`loop.${forEach.itemVar}.`)) : null;
    return {
        error: `source is required, and the prompt names ${distinct.length} different values (${distinct.map(p => `{{${p}}}`).join(', ')}) — which one is the text to read? Set source to ONE binding, e.g. source:{kind:"ref", path:"${own || distinct[0]}"}, at the top level of the step (a data_extraction has no inputs map).`,
        _fixHint: 'Reject reason: no source and several candidates in the prompt. Pick one, set it as source and resend the same step — the fields were fine.',
    };
}

// The tool that turns a listed file into text, when it is one this user has.
// Named only for a Nextcloud listing (or when the upstream tool is unknown):
// pointing a Drive listing at nextcloud_read_file would be the wrong repair.
function readToolFor(upstreamTool, draftWrap) {
    const available = draftWrap && draftWrap._availableToolNames;
    if (available && !available.has('nextcloud_read_file')) return null;
    if (typeof upstreamTool === 'string' && !upstreamTool.startsWith('nextcloud_')) return null;
    return 'nextcloud_read_file';
}

/**
 * The refusal for a data_extraction whose source reads a field its forEach
 * item does not have — the answer checkLoopRef gave as ok:false. A listing
 * entry has a path and never text, so the plain-item case spells out the
 * read step to add and the two bindings that then apply; a fan-out entry
 * that lacks the field names where the text actually sits.
 */
function loopItemSourceError(chk, forEach, draftWrap) {
    const up = chk.upstream || {};
    const v = forEach.itemVar;
    const overRef = forEach.overRef;
    const toolTag = up.tool ? ` (${up.tool})` : '';

    if (chk.ambiguous) {
        const field = chk.at.slice(`loop.${v}.`.length);
        return {
            error: `source reads "${chk.at}", but an entry of ${overRef}${toolTag} has "${field}" both under output and under item — bind the one you mean: ${chk.candidates.map(p => `source:{kind:"ref", path:"${p}"}`).join(' or ')}.`,
            _fixHint: 'Reject reason: the extraction reads a name the loop item has in two places. Pick one of the two paths named above as source and resend the same step; the fields were fine.',
        };
    }

    if (chk.fanout) {
        const outs = chk.outputFields;
        const textField = outs ? ['content', 'text', 'body', 'markdown'].find(f => outs.includes(f)) : null;
        const outPhrase = outs ? `output has: ${listNames(outs)}` : 'output has no described shape';
        const point = textField ? `the text is loop.${v}.output.${textField}` : `bind source to loop.${v}.output.<field>`;
        return {
            error: `source reads "${chk.at}", but an entry of ${overRef}${toolTag} is {index, item, output, status} and ${outPhrase} — ${point}.`,
            _fixHint: 'Reject reason: the extraction reads a field the loop item does not have. Point source at the field named above and resend the same step; the fields were fine.',
        };
    }

    const names = listNames(chk.itemFields);
    const listing = typeof up.tool === 'string' && LIST_TOOL_RX.test(up.tool);
    const has = listing ? `a listing carries ${names}, never a file's text` : `an entry has: ${names}`;
    const fileEntry = Array.isArray(chk.itemFields) && chk.itemFields.includes('path');
    let advice;
    if (fileEntry) {
        const readTool = readToolFor(up.tool, draftWrap);
        const readStep = readTool
            ? `an integration_action with tool:"${readTool}", inputs:{path:{kind:"ref", path:"loop.${v}.path"}}`
            : `an action that reads the file's text, with path:{kind:"ref", path:"loop.${v}.path"}`;
        advice = ` Read the file first: ${readStep} and forEach:{overRef:"${overRef}", itemVar:"${v}"}; then give THIS step forEach:{overRef:"steps.<read>.output.results", itemVar:"r"} (steps.$read… inside a batch) and source:{kind:"ref", path:"loop.r.output.content"}.`;
    } else {
        const dym = Array.isArray(chk.suggestions) && chk.suggestions.length ? ` Did you mean ${chk.suggestions.join(' or ')}?` : '';
        advice = `${dym} Bind source to one of those fields (source:{kind:"ref", path:"loop.${v}.<field>"}), or to the output of a step that produces the text, with a forEach over that step's results.`;
    }
    return {
        error: `source reads "${chk.at}", but the forEach item is an entry of ${overRef}${toolTag}, which has no "${chk.missing}" — ${has}.${advice}`,
        _fixHint: fileEntry
            ? 'Reject reason: the extraction reads a field the loop item does not have — a listing has no text. Add the read step and point source at its content; the fields were fine.'
            : 'Reject reason: the extraction reads a field the loop item does not have. Bind source to a field it has (named above) and resend the same step; the fields were fine.',
    };
}

/**
 * Pull named, typed fields out of a piece of text — on the admin's extraction
 * model, never the automation's tier. The `fields` list IS the output shape, so
 * there is no outputSchema to write.
 *
 * The default label MUST stay in step with nodeDefs.js's `defaultLabel` for
 * this type — nodeDefs.serverLabels.test.js reads both and compares them.
 */
function applyAddDataExtraction(draft, rawArgs, draftWrap) {
    const { args, notes, promptRefs } = translateDataExtractionVocabulary(rawArgs || {});
    const { forEach, error: feErr, notes: feNotes } = sanitizeForEach(args.forEach, draft, draftWrap);
    if (feErr) return { error: feErr };
    if (feNotes) notes.push(...feNotes);
    let raw = args.source;
    if (raw === undefined || raw === null || raw === '') {
        const derived = deriveDataExtractionSource({ promptRefs, forEach });
        if (derived && derived.error) return derived;
        if (derived) { raw = derived.source; notes.push(derived.note); }
    }
    const src = sanitizeDataExtractionSource(raw, draft, draftWrap);
    if (src.error) return { error: src.error, ...(src._fixHint ? { _fixHint: src._fixHint } : {}) };
    notes.push(...src.notes);
    let source = src.source;
    // The one binding this step has, checked against what its forEach item
    // actually looks like — repaired when the model skipped a fan-out's
    // envelope, refused when the item has no such field at all (the
    // 2026-09-12 extraction that read a listing entry's `content`).
    if (forEach && source.kind === 'ref' && typeof source.path === 'string' && source.path.startsWith(`loop.${forEach.itemVar}.`)) {
        const chk = checkLoopRef(draft, source.path, forEach, draftWrap);
        if (chk.ok && chk.path) {
            source = { ...source, path: chk.path };
            notes.push(chk.note.replace(/^binding /, 'source '));
        } else if (!chk.ok) {
            return loopItemSourceError(chk, forEach, draftWrap);
        }
    }
    const { fields, error: fieldErr } = sanitizeDataExtractionFields(args.fields);
    if (fieldErr) return { error: fieldErr };
    const loopErr = unboundLoopVarError({ source }, forEach, { what: 'source' });
    if (loopErr) return loopErr;
    if (args.instructions !== undefined && args.instructions !== null && typeof args.instructions !== 'string') {
        return { error: 'instructions must be a short string, e.g. "Amounts are in euros."' };
    }
    const instructions = typeof args.instructions === 'string' ? args.instructions.trim().slice(0, DATA_EXTRACTION_MAX_INSTRUCTIONS_CHARS) : '';
    const step = {
        id: newId('ex'),
        type: 'data_extraction',
        source,
        fields,
        ...(instructions ? { instructions } : {}),
        label: args.label || 'Extract data',
        ...(forEach ? { forEach } : {}),
    };
    appendAfter(draft, args.afterStepId, step, { branch: args.branch, caseName: args.caseName, splice: args.splice === true });
    return { added: step, ...(notes.length ? { _warnings: notes } : {}) };
}

// The keys a data_extraction step takes at the top of its args. An
// integration_action puts its per-tool arguments under `inputs`, and the
// model carries that habit across: measured 2026-09-12 with the fast local
// model — a batch whose data_extraction entry had {inputs:{source, fields},
// prompt} was rejected with "source is required", the model re-read the
// error, saw its `source` binding sitting right there (under inputs), and
// resent the byte-identical batch three rounds running until the repeat
// counter told it to give up. The error was true and useless: the binding
// existed, it was one level too deep. Unwrapping it here is what ends the
// loop; the note tells the model where the field belongs.
const DATA_EXTRACTION_INPUT_KEYS = ['source', 'fields', 'instructions', 'prompt', 'outputSchema'];

/**
 * Lift the data_extraction fields out of an `inputs` map the model wrapped
 * them in. Explicit top-level values win; `inputs` never reaches the step.
 * Also accepts `text`/`content`/`input` as the source's name — the words
 * the model reaches for when it has just read a file.
 */
function unwrapDataExtractionInputs(args) {
    const notes = [];
    const out = { ...args };
    const inputs = out.inputs;
    if (inputs && typeof inputs === 'object' && !Array.isArray(inputs)) {
        const moved = [];
        for (const k of DATA_EXTRACTION_INPUT_KEYS) {
            if (inputs[k] === undefined) continue;
            if (out[k] === undefined || out[k] === null || out[k] === '') { out[k] = inputs[k]; moved.push(k); }
        }
        if ((out.source === undefined || out.source === null || out.source === '')) {
            for (const alias of ['text', 'content', 'input', 'document']) {
                if (inputs[alias] !== undefined) { out.source = inputs[alias]; moved.push(`${alias} (as source)`); break; }
            }
        }
        delete out.inputs;
        if (moved.length) {
            notes.push(`${moved.map(k => `"${k}"`).join(', ')} ${moved.length > 1 ? 'were' : 'was'} sent under inputs — a data_extraction step has no inputs map: source, fields and instructions sit at the top level of the step. Moved up.`);
        } else {
            notes.push('inputs is integration_action vocabulary — a data_extraction step has no inputs map (source, fields, instructions sit at the top level); it was ignored.');
        }
    }
    if ((out.source === undefined || out.source === null || out.source === '')) {
        for (const alias of ['text', 'content', 'input', 'document']) {
            if (out[alias] !== undefined && out[alias] !== null && out[alias] !== '') {
                out.source = out[alias];
                delete out[alias];
                notes.push(`"${alias}" read as source — the text a data_extraction step reads is bound as \`source\`.`);
                break;
            }
        }
    }
    return { args: out, notes };
}

/** Every foreign vocabulary a data_extraction arrives in, in one pass. */
function translateDataExtractionVocabulary(rawArgs) {
    const un = unwrapDataExtractionInputs(rawArgs || {});
    const tr = translateAiStepVocabulary(un.args);
    return { args: tr.args, notes: [...un.notes, ...tr.notes], promptRefs: tr.promptRefs };
}

/**
 * ai_step vocabulary on a data_extraction, translated: `outputSchema` → the
 * fields list, `prompt` → the instructions hint. Seen in a real build: the
 * model had just written an ai_step, was told extraction is a
 * data_extraction step, switched the type — and kept prompt/outputSchema.
 * "fields is required" then sent it round again. The mapping is mechanical
 * (a schema property IS a field), so it is done here, and the note tells
 * the model the vocabulary it should have used. Explicit fields/instructions
 * always win; nothing is translated over them.
 *
 * `promptRefs` are the {{…}} placeholders the prompt carried, in order — the
 * prompt loses them, but a data_extraction with no source reads its source
 * off them (deriveDataExtractionSource).
 */
function translateAiStepVocabulary(args) {
    const notes = [];
    const out = { ...args };
    const promptRefs = typeof out.prompt === 'string'
        ? placeholdersOf(out.prompt)
        : [];
    const schema = out.outputSchema;
    if (!Array.isArray(out.fields) && schema && typeof schema === 'object' && !Array.isArray(schema)) {
        const props = (schema.properties && typeof schema.properties === 'object' && !Array.isArray(schema.properties))
            ? schema.properties : schema;
        const requiredList = Array.isArray(schema.required) ? schema.required : null;
        out.fields = Object.entries(props)
            .filter(([, p]) => !Array.isArray(p))
            .map(([name, p]) => {
                const t = p && typeof p === 'object' ? p.type : p;
                return {
                    name,
                    type: t === 'integer' ? 'number' : (typeof t === 'string' && t ? t : 'string'),
                    description: p && typeof p === 'object' && typeof p.description === 'string' ? p.description : '',
                    required: requiredList ? requiredList.includes(name) : (p && typeof p === 'object' && p.required === true),
                };
            });
        notes.push('outputSchema is ai_step vocabulary — converted to fields ([{name, type, description, required}] is what data_extraction declares; the fields ARE the output shape).');
    }
    if (typeof out.prompt === 'string' && (out.instructions === undefined || out.instructions === null || out.instructions === '')) {
        // The text itself arrives through `source`; a {{…}} placeholder in
        // the prompt would otherwise be pasted into the hint as dead words.
        const hint = replaceTemplate(out.prompt, () => '').replace(/[ \t]+\n/g, '\n').trim();
        if (hint) out.instructions = hint;
        notes.push('prompt is ai_step vocabulary — data_extraction reads `source` and takes at most a short `instructions` hint; the prompt text was kept as instructions with its {{…}} placeholders removed.');
    }
    delete out.outputSchema;
    delete out.prompt;
    return { args: out, notes, promptRefs };
}

module.exports = {
    sanitizeDataExtractionFields,
    sanitizeDataExtractionSource,
    deriveDataExtractionSource,
    loopItemSourceError,
    applyAddDataExtraction,
    unwrapDataExtractionInputs,
    translateDataExtractionVocabulary,
};
