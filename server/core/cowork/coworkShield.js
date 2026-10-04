/**
 * CW-10 — the privacy-shield passage for the NON-agent run path.
 *
 * The agent runtime gives every turn a PII gate before anything reaches a
 * model adapter (agentRuntime/chatWithAgent.js, "PII Detection"; the streaming
 * twin lives in guardrailsRunner.js). The plain Cowork/Automations path —
 * executeTask without an agent — and the Work composer called adapter.chat()
 * directly, unshielded, while the UI is about to claim otherwise. This module
 * is that same passage, callable from those two spots, behind the per-org
 * opt-in flag in core/entitlements/coworkShieldFlag.js.
 *
 * Contract:
 *   - Flag OFF, unreadable, or no org: return null having called nothing
 *     shield-side — not the org shield, not the guard client. The run path
 *     must stay byte-identical to today (existing orgs are stamped off; see
 *     the flag module's header for why default-off is load-bearing).
 *   - Flag ON: the agent path's passage, verbatim in behaviour —
 *     resolveShieldFor + validateInputForPii with the same arguments and the
 *     same failmode semantics (BFSF-269). Concretely:
 *       · masking actions (tokenize/redact/warn) rewrite the last user
 *         message in-place with `tokenizedText`, string and text-part
 *         content alike, exactly as chatWithAgent does;
 *       · a PII block ('PII Detected: …') and a fail-closed degraded guard
 *         (`privacyUnavailable`) are RETHROWN — the caller's own failure
 *         envelope decides what the user sees (the runner: a failed run
 *         carrying the message; the composer: the fallback spec, no model
 *         call). Never "shield unavailable ⇒ run unshielded";
 *       · any other error fails open, exactly like the agent path.
 *
 * Every require in here is lazy on purpose. This module is loaded by files
 * whose colocated tests stub no DB layer, and on the OFF path it must not
 * drag configStore/db — let alone the guard client — into their processes.
 */

'use strict';
const log = require('../../telemetry/log');

/**
 * Run the agent runtime's input-PII passage over `messages` when the org has
 * opted in. Mutates the last user message on a masking action.
 *
 * @param {object} opts
 * @param {string|null} opts.orgId  The ALREADY-resolved effective org
 *   (executeTask's userOrgForTier, the compose route's userOrgId). Callers
 *   never resolve a second time for this check.
 * @param {string|null} opts.userId The owner; doubles as the token-vault id,
 *   mirroring the agent path's `userAuth.userId`.
 * @param {Array<{role:string, content:any}>} opts.messages The outbound
 *   message array; the last entry is the user input to scan.
 * @returns {Promise<{tokenizedText:string, tokenMap:Object, entities:Array}|null>}
 *   The masking result when PII was tokenized (the message is already
 *   rewritten); null when nothing was masked or the shield did not apply.
 * @throws The agent path's deliberate gates, unchanged: 'PII Detected: …'
 *   when the resolved action is block, and an error with
 *   `privacyUnavailable = true` when detection is degraded under
 *   fail_closed (the default — an org opts into fail_open explicitly).
 */
async function applyCoworkShieldToInput({ orgId, userId = null, messages }) {
    if (!(await shieldApplies(orgId))) return null;

    // ── From here on: the agent path's PII block (chatWithAgent.js) ──────
    // Fetched at call time, not module load — same circular-import caution
    // piiDetection/validate.js documents for aiAgent.
    const aiConfigForPii = await require('../aiAgent').getAIConfig();
    const { resolveShieldFor } = require('../privacy/orgShield');
    const { validateInputForPii } = require('../privacy/piiDetection');

    // Falls back to the owner's personal shield when the org has none —
    // the same resolution the agent path runs (BFSF-290 twin).
    const orgShield = await resolveShieldFor({ orgId, userId });
    // PII gate: the shield's master `enabled` flag, or the global admin
    // toggle — the agent path's exact condition.
    const orgPiiEnabled = !!orgShield?.enabled;
    if (!(aiConfigForPii?.piiDetectionEnabled || orgPiiEnabled)) return null;

    try {
        const piiResult = await validateInputForPii(
            messages.slice(-3), orgPiiEnabled, orgShield,
            null, // no per-call action override on scheduled/composed runs
            null, // no accumulated conversation token map — each run stands alone
            { vaultUserId: userId || null },
        );

        if (piiResult && piiResult.tokenizedText) {
            // Redact/tokenize mode: replace the user input with the tokenized
            // version — string and text-part content both, like chatWithAgent.
            const lastMsg = messages[messages.length - 1];
            if (lastMsg && typeof lastMsg.content === 'string') {
                lastMsg.content = piiResult.tokenizedText;
            } else if (lastMsg && Array.isArray(lastMsg.content)) {
                const textPart = lastMsg.content.find(p => p.type === 'text');
                if (textPart) textPart.text = piiResult.tokenizedText;
            }
            log.warn(`[CoworkShield] 🔒 PII tokenized (${Object.keys(piiResult.tokenMap || {}).length} tokens)`);
            return piiResult;
        }
        return null;
    } catch (piiError) {
        // Propagate both a PII block and a fail-closed "protection
        // unavailable" block to the caller (BFSF-269).
        if (piiError?.message?.includes('PII Detected') || piiError?.privacyUnavailable) {
            throw piiError;
        }
        // Service unavailable → fail-open, exactly like the agent path.
        return null;
    }
}

/**
 * Does the shield apply to this path for `orgId`? No org means no flag and no
 * shield claim (the flag contract).
 */
async function shieldApplies(orgId) {
    if (!orgId) return false;
    try {
        return !!(await require('../entitlements/coworkShieldFlag').isCoworkShieldEnabled(orgId));
    } catch (_) {
        // The flag reader never throws by contract; a module that cannot even
        // load reads the same as an unreadable flag: OFF. This leniency is
        // ONLY about whether the shield applies — once the flag is on, the
        // failure semantics are the shield's own and stay fail-closed.
        return false;
    }
}

/**
 * The resolved shield for a run's tool loop, for its tool block lists
 * (core/privacy/toolPiiGate.js, BFSF-354): the same flag decision as the input
 * passage above. Flag OFF, unreadable, or no org: null, having called nothing
 * shield-side, so the run path stays as it was. Flag ON: the same resolution
 * (owner's personal shield when the org has none); a failed lookup throws, as
 * it does for the input passage.
 *
 * @param {{ orgId: string|null, userId?: string|null }} opts
 * @returns {Promise<object|null>}
 */
async function resolveCoworkToolShield({ orgId, userId = null }) {
    if (!(await shieldApplies(orgId))) return null;
    const { resolveShieldFor } = require('../privacy/orgShield');
    return resolveShieldFor({ orgId, userId });
}

module.exports = { applyCoworkShieldToInput, resolveCoworkToolShield };
