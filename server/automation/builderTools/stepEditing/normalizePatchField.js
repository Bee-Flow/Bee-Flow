// @typecheck
/**
 * builder_update_step — normalise one patched field to the exact shape the
 * matching apply* builder writes, so a patched step is byte-identical to a
 * freshly added one.
 *
 * The rules are data: FIELD_RULES holds, per step type, one small function per
 * field; TYPE_RULES holds a type whose every field goes through one shared
 * spec. A field without a rule is stored as given.
 */

const { normalizeApprovalConfig } = require('../approval');
// The leaf builders, not the stepBuilders index: the index and aiStep sit in
// the server's largest import cycle, their names come through cycleDeps.
const { clampDocumentTtl } = require('../stepBuilders/documentSteps');
const { normalizeAskOnce, normalizeCacheInto } = require('../stepBuilders/outboundSteps');
const { bindingToTemplate } = require('../stepBuilders/inputBindings');
const { NOTE_MAX_TEXT_LENGTH, NOTE_COLOR_KEYS, sanitizeNoteSize } = require('../stepBuilders/noteStep');
const { sanitizeSwitchCases } = require('../stepBuilders/flowSteps');
const cycleDeps = require('./cycleDeps');
const { normalizeQuery: normalizeHttpQuery } = require('../../../core/automationRunner/httpQuery');
const { KNOWLEDGE_WRITE_DUPLICATE_STRATEGIES, DATA_EXTRACTION_MAX_INSTRUCTIONS_CHARS } = require('../../validate/constants');
const { sanitizeAiStepReliabilityArgs } = require('../../../core/automationModel/aiStepReliability');

/** @typedef {(value: any, key: string) => any} FieldRule */

const SLIDE_LAYOUTS = ['title', 'section', 'bullets', 'two_column', 'cards', 'table', 'image', 'quote', 'chart', 'stats', 'timeline', 'closing'];
const DECK_LOOK_KEYS = ['preset', 'accent', 'background', 'font', 'titleFont', 'coverStyle', 'tableStyle', 'logo', 'logoPlacement', 'footerText', 'slideNumbers', 'template'];
const DATETIME_TEXT_KEYS = ['input', 'input2', 'format', 'part', 'unit', 'target', 'timezone', 'epochUnit'];

/** @param {unknown} v */
const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
/** A string as given, anything else → `fallback`. @param {unknown} fallback @returns {FieldRule} */
const stringOr = (fallback) => (v) => (typeof v === 'string' ? v : fallback);
/** A trimmed string, anything else → `fallback`. @param {unknown} fallback @returns {FieldRule} */
const trimmedOr = (fallback) => (v) => (typeof v === 'string' ? v.trim() : fallback);
/** A trimmed non-blank string, blank or anything else → `fallback`. @param {unknown} fallback @returns {FieldRule} */
const nonBlankTrimmedOr = (fallback) => (v) => ((typeof v === 'string' && v.trim()) ? v.trim() : fallback);
/** @type {FieldRule} */
const positiveIntOrAbsent = (v) => ((Number.isInteger(v) && v > 0) ? v : undefined);
/** @type {FieldRule} */
const documentTtl = (v) => clampDocumentTtl(Number.isFinite(Number(v)) ? v : 7);
/**
 * One rule for several fields.
 * @param {string[]} keys
 * @param {FieldRule} rule
 * @returns {Record<string, FieldRule>}
 */
const sameRule = (keys, rule) => Object.fromEntries(keys.map((k) => [k, rule]));

/**
 * temperature / enumFrom / checks / fallback of an ai_step, through the same
 * sanitiser the add path uses, so a patched step equals an added one. null
 * clears (so does an empty list). There is no error channel here (`undefined`
 * already means "clear"), so an unusable value is passed through UNCHANGED and
 * validateDefinition refuses it on save with the field and the allowed values,
 * the convention the code step's limits follow.
 * @type {FieldRule}
 */
function normalizeAiReliabilityPatch(value, key) {
    if (value === null || value === undefined) return undefined;
    if (Array.isArray(value) && value.length === 0 && (key === 'enumFrom' || key === 'checks')) return undefined;
    const r = sanitizeAiStepReliabilityArgs({ [key]: value });
    return 'error' in r ? value : r.value[key];
}

/**
 * The code step's limits: the add path's sanitizer, so a patched step is
 * byte-identical to a freshly-added one: all four keys present, the ones the
 * patch does not name filled from the sandbox's own defaults.
 *
 * REBUILT, NEVER MERGED into what the step already has — the discipline
 * `approval`, `askOnce`, `cacheInto` and `agentPermissions` all get, though the
 * reason here is a different one. It is not that a model invents keys (unknown
 * keys are refused outright); it is that normalizePatchField only ever sees the
 * VALUE, never the step, so a merge is not something this seam could do
 * honestly. That is survivable precisely because the add path writes all four
 * keys out: a partial block is always the model's own invention, never a shape
 * the builder produced, and re-stating the whole block is the obvious fix.
 *
 * There is also no error channel here (the function returns a value, and
 * `undefined` already means "clear this field"), so an unusable block is passed
 * through UNCHANGED rather than quietly repaired. validateDefinition runs on
 * every builder save (persistDraft) and refuses it there with
 * code.limits_out_of_range / code.limits_not_a_number, naming the real ceiling.
 * Repairing it here would hand the author a number they never asked for.
 * @type {FieldRule}
 */
function normalizeCodeLimits(value) {
    const { sanitizeCodeLimits } = require('../stepBuilders/dataSteps');
    const r = sanitizeCodeLimits(value);
    return r.error ? value : r.limits;
}

/**
 * Rebuilt, never merged: a model reaching for this invents `ttl`,
 * `cacheSeconds`, `scope`. The runtime reads none of them, so passing the
 * object through would persist a field that LOOKS configured and does nothing.
 */
const ASK_ONCE = { askOnce: (v) => normalizeAskOnce(v) };
const MAX_ITEMS = { maxItems: positiveIntOrAbsent };

/** The guard / tokenize / untokenize fields. */
const PRIVACY_RULES = {
    // A ref PATH string, as the add path stores it ('' = not picked yet).
    sourceRef: trimmedOr(''),
    // Narrow-only, like the runner (execPrivacy.narrowPolicy): a list of
    // category names, or absent for "every category the organisation allows".
    categories: (v) => {
        const list = Array.isArray(v) ? v.filter((c) => typeof c === 'string' && c) : [];
        return list.length ? list : undefined;
    },
    confidence: (v) => ((typeof v === 'number' && v > 0 && v <= 1) ? v : undefined),
    onFound: (v) => {
        const o = isPlainObject(v) ? v : {};
        const next = { ...(o.stop === true ? { stop: true } : {}), ...(o.mask === true ? { mask: true } : {}), ...(o.tokenize === true ? { tokenize: true } : {}) };
        return Object.keys(next).length ? next : undefined;
    },
};

/** @type {Record<string, Record<string, FieldRule>>} */
const FIELD_RULES = {
    ai_step: {
        systemPrompt: nonBlankTrimmedOr(null),
        modelTier: (v) => v || 'auto',
        allowTools: (v) => !!v,
        tools: (v) => (Array.isArray(v) ? v.filter((t) => typeof t === 'string') : null),
        outputSchema: (v) => v || null,
        // Always an explicit array (never absent), same reasoning as the
        // add-path builder: mirrors App Studio's knowledgeBaseIds shape and
        // means the runner never has to distinguish "not set" from "cleared".
        knowledgeBaseIds: (v) => (Array.isArray(v) ? v.filter((id) => typeof id === 'string' && id).slice(0, 10) : []),
        // The same three clamps the add path uses, so a patched step is
        // byte-identical to a freshly built one. `agentPermissions` is REBUILT
        // from its three known names and never merged: a patch of
        // `{useTools:true}` merged into the stored object would leave the other
        // two `undefined`, and an `undefined` a reader treats as "not false" is
        // exactly how a missing key comes to mean everything.
        agentId: (v) => cycleDeps.sanitizeAgentId(v),
        skillIds: (v) => cycleDeps.sanitizeSkillIds(v),
        agentPermissions: (v) => cycleDeps.sanitizeAgentPermissions(v),
        // The agent's skills this step switches off, replaced wholesale (send
        // the full list).
        disabledAgentSkillIds: (v) => cycleDeps.sanitizeDisabledAgentSkillIds(v),
        ...ASK_ONCE,
        ...sameRule(['temperature', 'enumFrom', 'checks', 'fallback'], normalizeAiReliabilityPatch),
    },
    code: {
        outputSchema: (v) => v || null,
        allowedTools: (v) => (Array.isArray(v) ? v : []),
        limits: normalizeCodeLimits,
    },
    notification: {
        channels: (v) => (Array.isArray(v) ? v : ['notification']),
    },
    form_page: {
        mode: (v) => (v === 'ending' ? 'ending' : 'input'),
        form: (v) => (isPlainObject(v) ? v : null),
        waitSeconds: (v) => Math.max(60, Math.min(7 * 24 * 3600, Math.round(Number(v) || 3600))),
        // The page condition: a trimmed expression, or null (always show the page).
        when: (v) => ((typeof v === 'string' && v.trim()) ? v.trim().slice(0, 2000) : null),
    },
    http_request: {
        method: (v) => String(v || 'GET').toUpperCase(),
        headers: (v) => (isPlainObject(v) ? v : {}),
        body: stringOr(''),
        query: (v) => normalizeHttpQuery(v),
        timeoutMs: (v) => Math.max(1000, Math.min(60000, Number(v) || 10000)),
        blockPrivateTargets: (v) => v !== false,
        // Anything unrecognised means 'auto' — the executor falls back the same
        // way, so a typo never silently disables parsing.
        parseResponse: (v) => (['never', 'always'].includes(v) ? v : 'auto'),
        ...ASK_ONCE,
        // Rebuilt, never merged, for the same reason as askOnce: a model
        // reaching for this invents `enabled`, `ttlDays`, `table`.
        cacheInto: (v) => normalizeCacheInto(v),
    },
    integration_action: { ...ASK_ONCE },
    // Same coercions applyAddGenerateDocument uses, so the clamps match validate.js.
    generate_document: {
        format: (v) => (v === 'docx' ? 'docx' : 'pdf'),
        contentFormat: (v) => (v === 'html' ? 'html' : 'markdown'),
        expiresInDays: documentTtl,
        ...sameRule(['content', 'title', 'fileName'], stringOr('')),
    },
    slide: {
        // 'auto' / anything unknown clears the layout, which the executor reads
        // as "pick one from the content".
        layout: (v) => (SLIDE_LAYOUTS.includes(v) ? v : undefined),
        ...sameRule(['title', 'content', 'notes'], stringOr('')),
        image: nonBlankTrimmedOr(undefined),
        // The visuals: the add path's sanitizer; an empty value clears the visual.
        ...sameRule(['chart', 'stats', 'style'], (v, key) => require('../stepBuilders/documentSteps').slideVisualFields({ [key]: v })[key]),
    },
    presentation: {
        format: (v) => (v === 'pdf' ? 'pdf' : 'pptx'),
        houseStyle: (v) => v !== false,
        expiresInDays: documentTtl,
        ...sameRule(['title', 'subtitle', 'fileName'], stringOr('')),
        // The look fields: a valid value or ABSENT (never ''), so the house
        // style decides again when a person clears one.
        ...sameRule(DECK_LOOK_KEYS, (v, key) => require('../stepBuilders/documentSteps').deckLookFields({ [key]: v })[key]),
        logo: (v) => {
            if (typeof v === 'string' && /^(none|off|false|no|geen)$/i.test(v.trim())) return 'none';
            return require('../stepBuilders/documentSteps').deckLookFields({ logo: v }).logo;
        },
        slides: (v) => {
            if (typeof v === 'string' || Array.isArray(v)) return v;
            if (v && typeof v === 'object' && v.kind) return bindingToTemplate(v);
            return '';
        },
    },
    fill_document: {
        expiresInDays: documentTtl,
        saveCopy: (v) => v === true,
        ...sameRule(['documentId', 'documentName', 'fileName', 'copyName'], stringOr('')),
        values: (v) => (isPlainObject(v) ? v : {}),
    },
    data_extraction: {
        // Same trim-and-cap applyAddDataExtraction applies; blank clears it.
        instructions: (v) => (typeof v === 'string' ? v.trim().slice(0, DATA_EXTRACTION_MAX_INSTRUCTIONS_CHARS) : '') || undefined,
    },
    switch: {
        // Shared with applyAddSwitch, so `expr` survives: rebuilding a case as
        // `{name, value}` here would erase the per-case rule the canvas editor
        // writes; see sanitizeSwitchCases for the full note.
        cases: (v) => sanitizeSwitchCases(v),
        defaultBranch: stringOr(null),
        // 'all' or absent. A string list keeps or enters list mode ('' =
        // source not picked yet, as the editor writes it); null takes the
        // switch out of list mode.
        matchMode: (v) => (v === 'all' ? 'all' : undefined),
        arrayRef: trimmedOr(undefined),
        ...MAX_ITEMS,
    },
    filter: { ...MAX_ITEMS },
    parse_json: {
        ...sameRule(['sourceRef', 'itemsRef'], stringOr('')),
        mode: (v) => (v === 'ai' ? 'ai' : 'paths'),
    },
    set: {
        // A string keeps/enters list mode ('' = list mode, source not picked
        // yet); null/anything else CLEARS the key → single mode.
        arrayRef: trimmedOr(undefined),
        ...MAX_ITEMS,
    },
    loop: { maxIterations: (v) => v || 100 },
    wait: { seconds: (v) => Math.max(1, Math.min(86400, Number(v) || 1)) },
    // Rebuilt, never merged: a model reaching for an approval routinely invents
    // `assignee` / `approvers` / `reminderHours`. The engine reads none of
    // them, so merging would persist a field that looks configured and does
    // nothing — the worst outcome for a step a person relies on.
    approval: { approval: (v) => normalizeApprovalConfig(v) },
    limit: {
        count: (v) => Math.max(0, Math.floor(Number(v) || 0)),
        mode: (v) => (v === 'last' ? 'last' : 'first'),
    },
    datatable: sameRule(['datatableId', 'datatableKey'], trimmedOr(undefined)),
    knowledge_write: {
        // The same flattening applyAddKnowledgeWrite does: a model that hands
        // over a binding object gets it turned back into the `{{…}}` string the
        // editor and the runner both read.
        ...sameRule(['content', 'title', 'sourceUri'], (v) => bindingToTemplate(v)),
        knowledgeBaseId: trimmedOr(undefined),
        nearDuplicateStrategy: (v) => (KNOWLEDGE_WRITE_DUPLICATE_STRATEGIES.includes(v) && v !== 'skip' ? v : undefined),
    },
    table: {
        name: nonBlankTrimmedOr(undefined),
        expiresInDays: (v) => require('../../../core/automationModel/tableOps/spec').normalizeTableStep({ expiresInDays: v }).expiresInDays,
    },
    guard: PRIVACY_RULES,
    tokenize: PRIVACY_RULES,
    untokenize: PRIVACY_RULES,
    dedupe: { keyField: stringOr(undefined) },
    flatten: {
        keepEmpty: (v) => (v === true ? true : undefined),
        ...MAX_ITEMS,
    },
    // Same clamps applyAddNote uses: text/size never land oversized, an unknown
    // colour is simply dropped rather than persisting a value the canvas would
    // fall back on anyway.
    note: {
        text: (v) => (typeof v === 'string' ? v.slice(0, NOTE_MAX_TEXT_LENGTH) : ''),
        position: (v) => ((v && typeof v === 'object' && Number.isFinite(Number(v.x)) && Number.isFinite(Number(v.y)))
            ? { x: Number(v.x), y: Number(v.y) } : undefined),
        size: (v) => sanitizeNoteSize(v),
        color: (v) => ((typeof v === 'string' && NOTE_COLOR_KEYS.has(v)) ? v : undefined),
    },
    datetime: {
        ...sameRule(DATETIME_TEXT_KEYS, stringOr(undefined)),
        // '' is meaningful for arrayRef: list mode with the source not picked yet.
        arrayRef: stringOr(undefined),
        amount: (v) => (typeof v === 'number' ? v : undefined),
    },
};

/** @type {Record<string, FieldRule>} */
const TYPE_RULES = {
    // The shared spec clamps each setting, so a patched step equals an added one.
    read_table: (v, key) => require('../../../core/automationModel/tableOps/readTableSpec').normalizeReadTableStep({ [key]: v })[key],
};

/**
 * @param {string} type
 * @param {string} key
 * @returns {FieldRule | null}
 */
function ruleFor(type, key) {
    const rules = Object.hasOwn(FIELD_RULES, type) ? FIELD_RULES[type] : null;
    if (rules && Object.hasOwn(rules, key)) return rules[key];
    return Object.hasOwn(TYPE_RULES, type) ? TYPE_RULES[type] : null;
}

/**
 * Normalize a scalar/structured patch field to the exact shape the matching
 * apply* builder would produce, so a patched step is byte-identical to a
 * freshly-added one. Returns `undefined` to mean "clear this optional field"
 * (the caller keeps an existing label instead of clearing it).
 * @param {string} type
 * @param {string} key
 * @param value the patched value, as the model sent it
 */
function normalizePatchField(type, key, value) {
    if (key === 'label') return (typeof value === 'string' && value.trim()) ? value : undefined;
    const rule = ruleFor(type, key);
    return rule ? rule(value, key) : value;
}

module.exports = { normalizePatchField };
