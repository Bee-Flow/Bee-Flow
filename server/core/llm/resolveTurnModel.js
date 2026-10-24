// @typecheck
'use strict';

/**
 * WHICH TIER A CHAT TURN RUNS ON — shared by the four chat surfaces that pick
 * a tier from the request themselves: direct chat (routes/ai/directChat/
 * turnSetup.js, and the Swarm branch in swarmTurn.js), notebook chat, webpage
 * chat and template chat.
 *
 * Each of them read `req.body.modelTier` and indexed its tier map with it, so
 * a member whose group may only use `fast` (the group's Allowed-tiers editor,
 * `allowedTiers`) could POST `modelTier: "pro"` and run on Deep Thinking: the
 * dropdown hid the tier, the route did not. The builders and the playbook
 * routes already refused that (core/entitlements/tierAccess); this is the same
 * refusal for the chats:
 *
 *   - A turn that names no tier runs on `fast`, exactly as before, unasked.
 *     So does one that names `fast`: it is the tier every request gets without
 *     naming one, so refusing it would close nothing.
 *   - A turn that names any other tier its groups do not allow is refused
 *     with tierAccess's 403 `tier_not_permitted`, before a model is resolved.
 *     The surface's own downgrades run first (the notebook reads `standard`
 *     as `fast`; direct chat runs Flow without its betas as `fast`), so what
 *     they downgrade is never refused.
 *   - `auto` is not refused: it is how a tier is chosen, and the classifier
 *     now chooses only from the tiers this person's groups allow (plus `fast`,
 *     the fallback it always had). For a person whose groups do not narrow
 *     anything the pool is the one it always was.
 *
 * Only the group narrowing is measured here (tierAccess.groupTierGateFor):
 * the beta features and task types are each surface's own rules and stay
 * where they are. The model and provider behind the tier stay with the
 * routes, whose fallbacks and error answers differ.
 */

const log = require('../../telemetry/log');
const { groupTierGateFor, tierRefusal } = require('../entitlements/tierAccess');

const DEFAULT_TIER = 'fast';
const AUTO = 'auto';

/** A tier this file measures: a name, and not the default nor `auto`. */
function isNamedTier(tier) {
    return typeof tier === 'string' && tier !== DEFAULT_TIER && tier !== AUTO;
}

/**
 * The refusal for a tier a turn names, or null when it may run on it.
 * @param {{ tier: unknown, userId: string|null|undefined, deps?: { groupTierGateFor?: Function } }} args
 * @returns {Promise<null | { status: number, code: string, error: string }>}
 */
async function turnTierRefusal({ tier, userId, deps = {} }) {
    if (!isNamedTier(tier)) return null;
    const gate = await (deps.groupTierGateFor || groupTierGateFor)({ userId });
    return gate.allows(tier) ? null : tierRefusal(tier);
}

/**
 * The tier a turn runs on, or the refusal to answer instead.
 *
 * @param {object} args
 * @param {unknown} args.modelTier         what the request named (req.body.modelTier)
 * @param {unknown} args.message           the turn's message, for the `auto` classifier
 * @param {Record<string, any>} args.tiers the surface's tier map
 * @param {string} args.userId
 * @param {string|null} [args.userOrgId]
 * @param {string} args.surface            log tag, e.g. 'NotebookChat'
 * @param {boolean} [args.standardIsFast]  the surface reads `standard` as `fast`
 * @param {boolean} [args.classifyAuto]    the surface resolves `auto` with the classifier
 * @param {(key: string) => boolean} [args.autoEligible] keys `auto` may land on at all
 * @param {{ groupTierGateFor?: Function, classifyWithLLM?: Function }} [args.deps]
 * @returns {Promise<{ tier: string, refusal?: undefined } | { refusal: { status: number, code: string, error: string }, tier?: undefined }>}
 */
async function resolveTurnTier({
    modelTier, message, tiers, userId, userOrgId = null, surface,
    standardIsFast = false, classifyAuto = true, autoEligible = () => true, deps = {},
}) {
    let resolvedTier = modelTier || DEFAULT_TIER;
    if (standardIsFast && resolvedTier === 'standard') resolvedTier = DEFAULT_TIER;

    const refusal = await turnTierRefusal({ tier: resolvedTier, userId, deps });
    if (refusal) {
        log.info(`[${surface}] Tier "${String(resolvedTier).slice(0, 60)}" is not allowed for this user's groups — refused`);
        return { refusal };
    }

    if (resolvedTier === AUTO && classifyAuto) {
        try {
            const gate = await (deps.groupTierGateFor || groupTierGateFor)({ userId });
            const pool = Object.fromEntries(Object.entries(tiers || {})
                .filter(([k]) => autoEligible(k) && (k === DEFAULT_TIER || gate.allows(k))));
            const classify = deps.classifyWithLLM || require('./promptClassifier').classifyWithLLM;
            const result = await classify(message, pool, { userOrgId, userId });
            resolvedTier = result.tier;
            log.info(`[${surface}] Auto: tier="${resolvedTier}" (${result.method}: ${result.reason})`);
        } catch (err) {
            log.info(`[${surface}] Auto classification failed: ${err.message}, using fast`);
            resolvedTier = DEFAULT_TIER;
        }
    }
    if (standardIsFast && resolvedTier === 'standard') resolvedTier = DEFAULT_TIER;
    // modelTier is request input (unknown); the callers' tier maps treat a non-name as unknown.
    return { tier: /** @type {string} */ (resolvedTier) };
}

module.exports = { resolveTurnTier, turnTierRefusal, DEFAULT_TIER };
