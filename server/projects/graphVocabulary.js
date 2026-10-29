// @typecheck strict
/**
 * The vocabulary of the Solution dependency graph (graph.js): the problem
 * codes, their prose and severity, the node ids, and the classification of one
 * reference. Pure.
 */

'use strict';

/** Problem codes, so a caller can style or filter without matching prose. */
const PROBLEM = {
    UNWIRED: 'unwired',              // the reference was never filled in
    MISSING: 'missing',              // the target does not exist at all
    EXTERNAL: 'external',            // it exists, but outside this Solution
    UNRESOLVED: 'unresolved',        // outside this Solution; existence unknown
    CROSS_OWNER: 'cross_owner',      // it exists here, but will refuse to run
};

/**
 * @param {string} type
 * @param {unknown} id
 */
function nodeId(type, id) { return `${type}:${id}`; }

/**
 * @param {string} ownerType
 * @param {unknown} ownerId
 * @param {unknown} stepId
 */
function approvalNodeId(ownerType, ownerId, stepId) {
    return `approval:${ownerType}:${ownerId}:${stepId}`;
}

/**
 * The synthetic node for an automation's own form.
 *
 * Keyed on the AUTOMATION, never on the form page: the page's id is its URL and
 * its credential. An automation has one form trigger, so the automation id is a
 * complete key anyway.
 * @param {unknown} automationId
 */
function formNodeId(automationId) { return `form:${automationId}`; }

/**
 * The synthetic node for "every meeting tagged X". The tag is author text.
 * @param {string} tag
 */
function meetingNodeId(tag) { return `meeting:${tag}`; }

/**
 * Classify one automation reference.
 *
 * `known` is the set of automation ids that exist beyond this project. When the
 * caller cannot supply it the verdict is UNRESOLVED rather than MISSING —
 * "I could not check" must not be reported as "it is gone".
 * @param {string | null | undefined} targetId
 * @param {Map<string, unknown>} byId
 * @param {Set<string> | null} known
 */
function classify(targetId, byId, known) {
    if (!targetId) return PROBLEM.UNWIRED;
    if (byId.has(targetId)) return null;
    if (!known) return PROBLEM.UNRESOLVED;
    return known.has(targetId) ? PROBLEM.EXTERNAL : PROBLEM.MISSING;
}

/**
 * What each kind of target is CALLED in a sentence.
 *
 * The prose does not always say "an automation": an edge can point at a table,
 * a knowledge base or a skill too, so the noun is a parameter — an unknown kind falls back to the neutral
 * "thing" rather than claiming the wrong one.
 */
/** @type {Record<string, string>} */
const TARGET_NOUN = {
    automation: 'automation',
    datatable: 'table',
    knowledge_base: 'knowledge base',
    skill: 'skill',
};

/** "a table", "an automation": the article the noun takes. */
const withArticle = (/** @type {string} */ noun) => `${/^[aeiou]/i.test(noun) ? 'an' : 'a'} ${noun}`;

/** @type {Record<string, (from: string, target: unknown, noun?: string) => string>} */
const PROSE = {
    [PROBLEM.UNWIRED]: (from, target, noun = 'automation') => `${from} has a step that never got ${withArticle(noun)} picked, so it does nothing when someone uses it.`,
    [PROBLEM.MISSING]: (from, target, noun = 'automation') => `${from} points at ${withArticle(noun)} that no longer exists (${target}).`,
    [PROBLEM.EXTERNAL]: (from, target, noun = 'automation') => `${from} depends on ${withArticle(noun)} outside this project (${target}), so packaging cannot carry it.`,
    [PROBLEM.UNRESOLVED]: (from, target, noun = 'automation') => `${from} points at ${withArticle(noun)} that is not in this project (${target}).`,
    // Deliberately NOT parameterised: cross-owner is the acts-as-owner refusal,
    // and only an automation is ever executed that way.
    [PROBLEM.CROSS_OWNER]: (from, target) => `${from} runs an automation owned by someone else (${target}). It will refuse at the moment someone presses the button — both must belong to the same person.`,
};

/**
 * The severity each problem carries on the shared Finding shape
 * (core/findings/finding.js). What is broken the moment someone clicks is an
 * error; what is a normal state while building (the "connect an automation" state
 * every template ships in), or a limit on packaging rather than on running,
 * is a warning. UNRESOLVED is "I could not check" and must never read as "it
 * is gone" — see classify().
 */
/** @type {Record<string, string>} */
const SEVERITY = {
    [PROBLEM.UNWIRED]: 'warning',
    [PROBLEM.MISSING]: 'error',
    [PROBLEM.EXTERNAL]: 'warning',
    [PROBLEM.UNRESOLVED]: 'warning',
    [PROBLEM.CROSS_OWNER]: 'error',
};

module.exports = { PROBLEM, PROSE, SEVERITY, TARGET_NOUN, nodeId, approvalNodeId, formNodeId, meetingNodeId, classify };
