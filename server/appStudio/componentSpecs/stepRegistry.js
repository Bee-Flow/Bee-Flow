// @typecheck strict
/**
 * App Studio catalog — the step registry: a step kind added after the base
 * catalogue is ONE file, `steps/<kind>.js`, found by a sorted directory read
 * and loaded after the base kinds. Everything that used to be a hand-kept list
 * of kinds is derived here from the base table (stepMeta.js) plus those files.
 *
 * A registry file exports:
 *   kind        its own file name
 *   since       the schema version that introduced it (3 or later)
 *   side        'client' | 'server' | 'control'
 *   fields      the field table, as in STEP_SPECS
 *   childSlots  [{ field, each?, walked? }]: the fields that hold steps ([] for none)
 *   retrySafe   may a failed step be tried again
 *   policy      one value per execution form (stepMeta.js POLICY_FORMS), every form
 *   budget      server kinds: 'ai' | 'heavy' | 'light'
 *   handler     server kinds: 'file' (actionExecutor/steps/<kind>.mts exports `runStep`)
 *   and optionally the flags of stepMeta.js (writesRecords, noLoop, inLoop, summary, writesVars)
 *
 * A file that leaves out or misspells any of it fails the load, so a kind can
 * never reach a route with a missing answer. After adding or changing a file:
 * `node server/appStudio/stepKindsGen.mts`, then `npm run gen:shared`.
 *
 * Plain .js like the rest of componentSpecs (see stepEnvelope.js).
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { BASE_STEP_META, POLICY_FORMS } = require('./stepMeta');

/** @typedef {import('./stepMeta').StepMeta} StepMeta */
/** @typedef {{ field: string, each?: string, walked?: boolean }} ChildSlotSpec */
/** @typedef {StepMeta & { kind: string, since: number, fields: Record<string, { type?: string }>, childSlots: ChildSlotSpec[] }} StepKindEntry */

const STEPS_DIR = path.join(__dirname, 'steps');
const KIND_RE = /^[a-z][a-z0-9_]{1,39}$/;
const SIDES = ['client', 'server', 'control'];
const BUDGETS = ['ai', 'heavy', 'light'];

/** @param {unknown} v @returns {v is Record<string, unknown>} */
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * Why `entry` is not a usable registry kind, as sentences; empty when it is.
 *
 * @param {unknown} entry
 * @param {string} name   the file name without extension
 * @returns {string[]}
 */
function stepKindProblems(entry, name) {
    if (!isObject(entry)) return [`${name}: must export an object`];
    /** @type {string[]} */
    const out = [];
    const say = (/** @type {string} */ text) => out.push(`${name}: ${text}`);
    if (entry.kind !== name || !KIND_RE.test(name)) say('`kind` must equal the file name (lower case, digits, underscores)');
    if (Object.hasOwn(BASE_STEP_META, name)) say('is a base step kind; the registry only adds kinds');
    if (!Number.isInteger(entry.since) || /** @type {number} */ (entry.since) < 3) say('`since` must be the schema version that introduced it (3 or later)');
    if (!SIDES.includes(/** @type {string} */ (entry.side))) say(`\`side\` must be one of ${SIDES.join(', ')}`);
    if (!isObject(entry.fields)) say('`fields` must be the field table');
    if (typeof entry.retrySafe !== 'boolean') say('`retrySafe` must be true or false');
    out.push(...policyProblems(entry, name), ...slotProblems(entry, name));
    const server = entry.side === 'server';
    if (server && !BUDGETS.includes(/** @type {string} */ (entry.budget))) say(`a server kind needs \`budget\`: ${BUDGETS.join(', ')}`);
    if (server && entry.handler !== 'file') say("a server kind needs `handler: 'file'`");
    if (!server && (entry.budget !== undefined || entry.handler !== undefined)) say('only a server kind has `budget` and `handler`');
    if (server && isObject(entry.policy) && entry.policy.click === 'browser') say('a server kind cannot run in the browser (`policy.click`)');
    if (!server && isObject(entry.policy) && (entry.policy.click === 'step' || entry.policy.click === 'stream')) say('only a server kind is posted to the server (`policy.click`)');
    if (entry.summary !== undefined && typeof entry.summary !== 'function') say('`summary` must be a function of the step');
    return out;
}

/** @param {Record<string, unknown>} entry @param {string} name @returns {string[]} */
function policyProblems(entry, name) {
    const policy = entry.policy;
    if (!isObject(policy)) return [`${name}: \`policy\` must give a value for every execution form (${Object.keys(POLICY_FORMS).join(', ')})`];
    /** @type {string[]} */
    const out = [];
    for (const [form, values] of Object.entries(POLICY_FORMS)) {
        if (!values.includes(/** @type {string} */ (policy[form]))) out.push(`${name}: policy.${form} must be one of ${values.join(', ')}`);
    }
    for (const form of Object.keys(policy)) {
        if (!Object.hasOwn(POLICY_FORMS, form)) out.push(`${name}: policy.${form} is not an execution form`);
    }
    return out;
}

/** @param {Record<string, unknown>} entry @param {string} name @returns {string[]} */
function slotProblems(entry, name) {
    if (!Array.isArray(entry.childSlots)) return [`${name}: \`childSlots\` must list the fields that hold steps ([] for none)`];
    const fields = isObject(entry.fields) ? entry.fields : {};
    /** @type {string[]} */
    const out = [];
    const declared = new Set();
    for (const slot of entry.childSlots) {
        if (!isObject(slot) || typeof slot.field !== 'string' || !Object.hasOwn(fields, slot.field)) {
            out.push(`${name}: every child slot names one of its own fields`);
            continue;
        }
        declared.add(slot.field);
        if (slot.each !== undefined && (typeof slot.each !== 'string' || !KIND_RE.test(slot.each))) out.push(`${name}: childSlots.${slot.field}.each must be a key name`);
        // A server step is ONE step for the browser: children it walked itself would get ordinals nobody posts.
        if (entry.side === 'server' && slot.walked !== false) out.push(`${name}: a server kind keeps its children (childSlots.${slot.field} needs walked: false)`);
    }
    for (const [field, fs] of Object.entries(fields)) {
        if (isObject(fs) && fs.type === 'steps' && !declared.has(field)) out.push(`${name}: field "${field}" holds steps but is not in childSlots`);
    }
    if (declared.has('onError') || declared.has('retry')) out.push(`${name}: onError and retry belong to the step envelope`);
    return out;
}

/**
 * The registry kinds in `dir`, sorted by file name. Throws on the first file
 * that is not a complete entry.
 *
 * @param {string} [dir]
 * @returns {StepKindEntry[]}
 */
function loadStepKindFiles(dir = STEPS_DIR) {
    const names = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.js') && !f.endsWith('.test.js')).sort() : [];
    return names.map((file) => {
        const name = file.slice(0, -3);
        const entry = require(path.join(dir, file));
        const problems = stepKindProblems(entry, name);
        if (problems.length) throw new Error(`Step registry: ${problems.join('; ')}`);
        return /** @type {StepKindEntry} */ (entry);
    });
}

/**
 * kind → meta for the base kinds followed by `entries`, in catalogue order.
 *
 * @param {readonly StepKindEntry[]} entries
 * @returns {Readonly<Record<string, StepMeta>>}
 */
function stepMetaTable(entries) {
    /** @type {Record<string, StepMeta>} */
    const table = { ...BASE_STEP_META };
    for (const entry of entries) {
        const { kind: _kind, fields: _fields, childSlots: _childSlots, ...meta } = entry;
        table[entry.kind] = Object.freeze(meta);
    }
    return Object.freeze(table);
}

/**
 * Every kind list the policies read, derived from a meta table. All in
 * catalogue order.
 *
 * @param {Readonly<Record<string, StepMeta>>} table
 */
function policyLists(table) {
    const kinds = Object.keys(table);
    const server = kinds.filter((k) => table[k].side === 'server');
    const other = kinds.filter((k) => table[k].side !== 'server');
    /** @param {readonly string[]} list @param {keyof import('./stepMeta').StepPolicy} form @param {...string} values */
    const where = (list, form, ...values) => Object.freeze(list.filter((k) => values.includes(table[k].policy[form])));
    return Object.freeze({
        hookStepKinds: where(server, 'mailboxHook', 'run'),
        hookControlKinds: where(other, 'mailboxHook', 'run'),
        backgroundRefusedKinds: where(kinds, 'background', 'refuse'),
        backgroundDeferredKinds: where(kinds, 'background', 'defer'),
        mcpLiveKinds: where(server, 'mcpRun', 'run'),
        mcpDryRunKinds: where(server, 'mcpDryRun', 'mock', 'run'),
        mcpMockableKinds: where(server, 'mcpDryRun', 'mock'),
        publicDeniedKinds: where(server, 'public', 'refuse'),
        heavyStepKinds: Object.freeze(server.filter((k) => table[k].budget === 'heavy' || table[k].budget === 'ai')),
        aiStepKinds: Object.freeze(server.filter((k) => table[k].budget === 'ai')),
        recordWriteKinds: Object.freeze(kinds.filter((k) => table[k].writesRecords === true)),
        retryUnsafeKinds: Object.freeze(kinds.filter((k) => table[k].retrySafe === false)),
    });
}

/**
 * The catalogue's kind lists: the base literal followed by the registry kinds.
 *
 * @param {readonly string[]} baseKinds
 * @param {readonly string[]} baseServerKinds
 * @param {readonly StepKindEntry[]} [entries]
 */
function extendKindLists(baseKinds, baseServerKinds, entries = EXTENSION_STEP_ENTRIES) {
    return {
        STEP_KINDS: [...baseKinds, ...entries.map((e) => e.kind)],
        DATA_MUTATING_STEP_KINDS: [...baseServerKinds, ...entries.filter((e) => e.side === 'server').map((e) => e.kind)],
    };
}

/**
 * The STEP_SPECS entries of the registry kinds (the envelope is added by
 * stepEnvelope.withErrorEnvelope, like for every other kind).
 *
 * @param {readonly StepKindEntry[]} entries
 */
function stepSpecsOf(entries) {
    /** @type {Record<string, { mutatesData: boolean, fields: Record<string, unknown>, since: number, retrySafe: boolean }>} */
    const out = {};
    for (const e of entries) out[e.kind] = { mutatesData: e.side === 'server', fields: e.fields, since: e.since, retrySafe: e.retrySafe };
    return out;
}

/**
 * What the pure step helpers and the browser read about the registry kinds
 * (the content of shared/appDefinition/stepKinds.generated.mjs).
 *
 * @param {readonly StepKindEntry[]} entries
 */
function stepFlowProjection(entries) {
    /** @type {Record<string, { childSlots: ChildSlotSpec[], retrySafe: boolean, server: boolean }>} */
    const out = {};
    for (const e of entries) {
        out[e.kind] = {
            childSlots: e.childSlots.map((s) => ({ field: s.field, ...(s.each !== undefined ? { each: s.each } : {}), ...(s.walked === false ? { walked: false } : {}) })),
            retrySafe: e.retrySafe,
            server: e.side === 'server',
        };
    }
    return out;
}

const EXTENSION_STEP_ENTRIES = Object.freeze(loadStepKindFiles());
const STEP_META = stepMetaTable(EXTENSION_STEP_ENTRIES);
const STEP_POLICY_LISTS = policyLists(STEP_META);

/** @param {unknown} kind @returns {StepMeta | null} */
function stepMetaOf(kind) {
    return typeof kind === 'string' && Object.hasOwn(STEP_META, kind) ? STEP_META[kind] : null;
}

/**
 * What an execution form does with a step of `kind`. A kind nobody declared,
 * or a row without that form, is refused (a dry run skips it).
 *
 * @param {unknown} kind
 * @param {keyof import('./stepMeta').StepPolicy} form
 * @returns {string}
 */
function stepPolicy(kind, form) {
    const value = stepMetaOf(kind)?.policy?.[form];
    if (typeof value === 'string' && POLICY_FORMS[form].includes(value)) return value;
    return form === 'mcpDryRun' ? 'skip' : 'refuse';
}

module.exports = {
    STEPS_DIR,
    EXTENSION_STEP_ENTRIES,
    EXTENSION_STEP_SPECS: stepSpecsOf(EXTENSION_STEP_ENTRIES),
    STEP_META,
    STEP_POLICY_LISTS,
    stepMetaOf,
    stepPolicy,
    stepKindProblems,
    loadStepKindFiles,
    stepMetaTable,
    policyLists,
    extendKindLists,
    stepSpecsOf,
    stepFlowProjection,
};
