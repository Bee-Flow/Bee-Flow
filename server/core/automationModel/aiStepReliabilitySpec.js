// @typecheck
'use strict';

/**
 * The vocabulary of the reliability settings of an ai_step (see
 * aiStepReliability.js): the limits, the allowed values, the three kinds of
 * path, and the small predicates the problem finder and the readers share.
 * Pure: requires nothing outside shared/expr.
 */

const { parsePath } = require('../../shared/expr/index.mjs');

const AI_STEP_DEFAULT_TEMPERATURE = 0.2;
const AI_STEP_TEMPERATURE_MIN = 0;
const AI_STEP_TEMPERATURE_MAX = 2;
const MAX_ENUM_FROM = 10;
const MAX_CHECKS = 20;
const MAX_FALLBACK_FIELDS = 50;
const FOREACH_CONCURRENCY_MAX = 1000;
const CHECK_KINDS = Object.freeze(['allowedFrom', 'numbersFrom', 'script', 'items']);
const SCRIPTS = Object.freeze(['latin', 'cyrillic', 'greek', 'arabic', 'hebrew', 'han', 'japanese', 'hangul', 'devanagari', 'thai']);
const RUN_PATH_ROOTS = Object.freeze(['trigger', 'steps', 'vars', 'loop']);

const MAX_FIELD_PATH_CHARS = 200;
const MAX_FIELD_SEGMENTS = 4;
const MAX_SEGMENT_CHARS = 100;
const MAX_RUN_PATH_CHARS = 300;
const MAX_ITEM_PATH_CHARS = 300;
const MAX_ITEMS_BOUND = 10000;
const MAX_IGNORE_UP_TO = 1000;
const BINDING_KINDS = Object.freeze(['literal', 'ref', 'template', 'expr']);

const ENUM_KEYS = Object.freeze(['field', 'ref', 'value', 'ignoreCase', 'allowEmpty']);
const CHECK_KEYS = Object.freeze({
    allowedFrom: ['kind', 'field', 'ref', 'value', 'ignoreCase', 'allowEmpty'],
    numbersFrom: ['kind', 'field', 'ref', 'tolerance', 'ignoreUpTo', 'percent', 'ignoreDates'],
    script: ['kind', 'field', 'script', 'minRatio'],
    items: ['kind', 'field', 'minItems', 'maxItems', 'sameCountAs'],
});
const FALLBACK_KEYS = Object.freeze(['kind', 'fields']);

/** @param {any} v @returns {boolean} */
const isObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
/** @param {any} v @returns {boolean} */
const present = (v) => v !== undefined && v !== null;

/**
 * @typedef {{ code: string, path: string, severity: 'error'|'warning', message: string, hint: string }} Problem
 * @typedef {{ segments: Array<{ name: string, each: boolean }> }} ParsedFieldPath
 */

// ── Paths ─────────────────────────────────────────────────────────────────

/**
 * A field path as segments, or null when it is not one: 1..4 segments joined
 * by '.', each a name of 1..100 characters without '.', '[' or ']',
 * optionally suffixed '[]' (every item of that list); 200 characters at most.
 * @param {any} path
 * @returns {ParsedFieldPath | null}
 */
function parseFieldPath(path) {
    if (typeof path !== 'string' || !path || path.length > MAX_FIELD_PATH_CHARS) return null;
    const parts = path.split('.');
    if (parts.length > MAX_FIELD_SEGMENTS) return null;
    /** @type {{ name: string; each: boolean; }[]} */
    const segments = [];
    for (const part of parts) {
        const each = part.endsWith('[]');
        const name = each ? part.slice(0, -2) : part;
        if (!name || name.length > MAX_SEGMENT_CHARS || /[.[\]]/.test(name)) return null;
        segments.push({ name, each });
    }
    return { segments };
}

/**
 * Why a run path is unusable, or null when it is fine. 'secrets' is named
 * apart because it is a refusal on principle, not a typo.
 * @param {any} value
 * @returns {null | 'type' | 'empty' | 'long' | 'braces' | 'syntax' | 'secrets' | 'root'}
 */
function runPathFault(value) {
    if (typeof value !== 'string') return 'type';
    const p = value.trim();
    if (!p) return 'empty';
    if (p.length > MAX_RUN_PATH_CHARS) return 'long';
    if (p.includes('{{')) return 'braces';
    const tokens = parsePath(p);
    if (!tokens || !tokens.length || tokens[0].type !== 'prop') return 'syntax';
    const root = String(tokens[0].key);
    if (root === 'secrets') return 'secrets';
    return RUN_PATH_ROOTS.includes(root) ? null : 'root';
}

/**
 * Whether a path inside one list item is readable ("id", "name.en", "[0]").
 * @param {any} value
 */
function itemPathFault(value) {
    if (typeof value !== 'string') return 'type';
    const p = value.trim();
    if (!p) return 'empty';
    if (p.length > MAX_ITEM_PATH_CHARS) return 'long';
    if (p.includes('{{')) return 'braces';
    return parsePath(p.startsWith('[') ? `$${p}` : `$.${p}`) ? null : 'syntax';
}

/** A top-level output field name: what a fallback value is filed under. @param {any} name */
function isFieldName(name) {
    return typeof name === 'string' && name.length >= 1 && name.length <= MAX_SEGMENT_CHARS && !/[.[\]]/.test(name);
}

/**
 * Whether this step may offer the model a tool: allowTools, an allowlist, a
 * skill, or an agent that may use its tools or start automations. The reuse of
 * answers and the parallel run per item both stand down for such a step,
 * because a tool may change things. The ONE rule: the runner
 * (automationRunner/forEachConcurrency.js), the validator and the form
 * (agent-hub canRunItemsInParallel) all follow it.
 * @param {any} step
 */
function aiStepCanCallTools(step) {
    if (!isObject(step)) return false;
    if (step.allowTools === true) return true;
    if (Array.isArray(step.tools) && step.tools.length > 0) return true;
    if (Array.isArray(step.skillIds) && step.skillIds.length > 0) return true;
    const hasAgent = typeof step.agentId === 'string' && step.agentId.trim() !== '';
    const p = step.agentPermissions;
    return hasAgent && isObject(p) && (p.useTools === true || p.startAutomations === true);
}

/** A binding as the runner reads one: a kind and the payload that kind needs. @param {any} b */
function isBinding(b) {
    if (!isObject(b) || !BINDING_KINDS.includes(b.kind)) return false;
    if (b.kind === 'literal') return 'value' in b && b.value !== undefined;
    if (b.kind === 'ref') return typeof b.path === 'string' && b.path.trim() !== '';
    return typeof b.value === 'string';
}

module.exports = {
    AI_STEP_DEFAULT_TEMPERATURE,
    AI_STEP_TEMPERATURE_MIN,
    AI_STEP_TEMPERATURE_MAX,
    MAX_ENUM_FROM,
    MAX_CHECKS,
    MAX_FALLBACK_FIELDS,
    FOREACH_CONCURRENCY_MAX,
    CHECK_KINDS,
    SCRIPTS,
    RUN_PATH_ROOTS,
    MAX_SEGMENT_CHARS,
    MAX_RUN_PATH_CHARS,
    MAX_ITEM_PATH_CHARS,
    MAX_ITEMS_BOUND,
    MAX_IGNORE_UP_TO,
    ENUM_KEYS,
    CHECK_KEYS,
    FALLBACK_KEYS,
    isObject,
    present,
    isBinding,
    isFieldName,
    parseFieldPath,
    runPathFault,
    itemPathFault,
    aiStepCanCallTools,
};
