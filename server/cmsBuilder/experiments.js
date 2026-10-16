// @typecheck
'use strict';
/**
 * A/B experiments on a CMS block: the content fields and what is wrong with them.
 *
 * A block turns into an experiment by carrying four content fields:
 *
 *   abKey    name of the experiment (what Umami groups the events by)
 *   abAlt    partial content of the alternative; merged over the block's own content
 *   abShare  percentage (1-99) of page views that see the alternative, default 50
 *   abGoal   optional name of the goal event, default 'ab_goal'
 *
 * The browser draws the variant (agent-hub/src/marketing/experiments/); the server only
 * stores the fields, keeps them out of the crawler's view (renderBlocks) and
 * out of the translator (cmsTranslate), and warns here about values the
 * browser would ignore.
 */

const KEY_RE = /^[a-z0-9][a-z0-9_-]{0,39}$/;

// Mirror of agent-hub/src/marketing/experiments/altPolicy.ts. The submit route
// validates and records against the published block, so an alternative must not
// change what a visitor consents to or submits; the browser drops these keys.
const ALT_DENY_ALL = ['consent', 'automationId'];
const NO_EXPERIMENT_TYPES = ['form', 'customer-support'];

/** @param {unknown} v @returns {v is Record<string, unknown>} */
function isPlainObject(v) {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/**
 * @typedef {{ code: string, path: string, message: string, hint: string }} ExperimentWarning
 */

/**
 * Warnings for one block's experiment fields; empty when the block is no experiment.
 * @param {{ type?: string, content?: unknown } | null | undefined} block
 * @param {string} contentPath path of the block's content, for the warning records
 * @returns {ExperimentWarning[]}
 */
function experimentWarnings(block, contentPath) {
    const content = block?.content;
    if (!isPlainObject(content)) return [];
    const { abKey, abAlt, abShare, abGoal } = content;
    if (abKey === undefined && abAlt === undefined && abShare === undefined && abGoal === undefined) return [];
    /** @type {ExperimentWarning[]} */
    const out = [];
    if (NO_EXPERIMENT_TYPES.includes(String(block?.type))) {
        out.push({
            code: 'experiment_on_submission_block',
            path: `${contentPath}.abKey`,
            message: `A ${block?.type} block takes submissions and cannot run an A/B test.`,
            hint: 'Its consent wording and fields are checked against the published block, so a variant would record consent for text the visitor did not see. The experiment fields are ignored; remove them.',
        });
    }
    if (typeof abKey !== 'string' || !KEY_RE.test(abKey)) {
        out.push({
            code: 'bad_experiment_key',
            path: `${contentPath}.abKey`,
            message: `abKey ${JSON.stringify(abKey)} is not a usable experiment name.`,
            hint: 'Use 1-40 characters from a-z, 0-9, "-" and "_", starting with a letter or digit. Without a valid abKey the block is shown as it is, with no experiment.',
        });
    }
    if (!isPlainObject(abAlt) || Object.keys(abAlt).length === 0) {
        out.push({
            code: 'bad_experiment_alt',
            path: `${contentPath}.abAlt`,
            message: 'abAlt must be an object holding the content that differs in the alternative.',
            hint: 'Put only the fields that change, for example { "title": "..." }. Without it every visitor sees the control.',
        });
    }
    if (abShare !== undefined && !(typeof abShare === 'number' && abShare >= 1 && abShare <= 99)) {
        out.push({
            code: 'bad_experiment_share',
            path: `${contentPath}.abShare`,
            message: `abShare ${JSON.stringify(abShare)} is not a percentage between 1 and 99.`,
            hint: 'The share of page views that see the alternative; 50 is an even split. Anything else is treated as 50.',
        });
    }
    if (abGoal !== undefined && (typeof abGoal !== 'string' || !KEY_RE.test(abGoal))) {
        out.push({
            code: 'bad_experiment_goal',
            path: `${contentPath}.abGoal`,
            message: `abGoal ${JSON.stringify(abGoal)} is not a usable event name.`,
            hint: 'Use 1-40 characters from a-z, 0-9, "-" and "_". Anything else falls back to "ab_goal".',
        });
    }
    if (isPlainObject(abAlt)) {
        const denied = [...ALT_DENY_ALL, ...(NO_EXPERIMENT_TYPES.includes(String(block?.type)) ? ['fields'] : [])];
        for (const key of denied.filter(k => k in abAlt)) {
            out.push({
                code: 'experiment_alt_forbidden',
                path: `${contentPath}.abAlt.${key}`,
                message: `abAlt.${key} cannot differ in an alternative; the page ignores it.`,
                hint: 'Consent wording, form fields and the automation are submission settings that the server checks against the published block. Remove it from abAlt.',
            });
        }
    }
    return out;
}

module.exports = { experimentWarnings, KEY_RE };
