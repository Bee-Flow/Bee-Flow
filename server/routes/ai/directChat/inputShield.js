/** @typedef {import('../../../core/agentRuntime/chatStream/turnState').ChatMessage} ChatMessage */
// @typecheck
/**
 * Direct Chat input gates, part one: the Unicode-smuggling defense and the
 * Privacy Shield this turn runs under (org shield, the personal shield of a
 * consumer account, or the sole org shield for a super-admin without an org
 * binding). Split out of inputGates.js; behaviour unchanged.
 */

const configStore = require('../../../stores/configStore');
const guardrailEventStore = require('../../../stores/guardrailEventStore');
const log = require('../../../telemetry/log');
const { bestEffort } = require('../../../utils/bestEffort');

/**
 * Must run FIRST, before moderation, PII and regex guardrails: strips hidden
 * payloads encoded via Variation Selectors / Tags block.
 * @param {(arg0: string, arg1: { strippedCount: number; messageIndices: number[]; }) => void} send
 * @param {ChatMessage[]} messages
 */
function stripUnicodeSmuggling(messages, send) {
    const { sanitizeMessagesUnicode } = require('../../../utils/unicodeSanitizer');
    const unicodeResult = sanitizeMessagesUnicode(messages);
    if (unicodeResult.smugglingDetected) {
        log.warn(`[DirectChat] 🚨 Unicode smuggling stripped: ${unicodeResult.totalStripped} hidden chars`);
        send('unicode_smuggling_detected', {
            strippedCount: unicodeResult.totalStripped,
            messageIndices: unicodeResult.detectedIn,
        });
    }
    return unicodeResult;
}

/**
 * The deferred audit row for stripped smuggling (it needs the org id).
 * @param {{ smugglingDetected: boolean; totalStripped: number; detectedIn: number[]; }} unicodeResult
 */
function logUnicodeSmuggling(unicodeResult, { userOrgId, userId, convId, modelId }) {
    if (!unicodeResult.smugglingDetected) return;
    guardrailEventStore.logGuardrailEvent({
        organization_id: userOrgId || null,
        user_id: userId,
        conversation_id: convId || null,
        violation_type: 'unicode_smuggling',
        violation_categories: `${unicodeResult.totalStripped} hidden chars`,
        direction: 'input',
        action_taken: 'stripped',
        source: 'direct',
        model: modelId || null,
    }).catch((e) => bestEffort('routes/ai/directChat/inputShield:logUnicodeSmuggling', e));
}

/**
 * The caller's org for shield/PII resolution. Super-admins get `null` from
 * resolveUserOrgIds (intentional: it bypasses org-scoped filtering for read
 * queries); here their actual org binding is still wanted, so fall back to
 * session.user.organizationId.
 */
async function resolveTurnOrgId(req) {
    const { resolveUserOrgIds } = require('../../../auth');
    const userOrgIds = await resolveUserOrgIds(req);
    return (userOrgIds && userOrgIds.size > 0)
        ? Array.from(userOrgIds)[0]
        : (req.session?.user?.organizationId || null);
}

/**
 * Resolve the Privacy Shield for this turn. Org-bound users get their org
 * shield; consumer accounts (no org) fall back to their own user-level
 * shield from the personal Privacy Shield settings. Reading only the org key
 * meant typed text went to the model unprotected on personal accounts while
 * their PDFs were redacted (BFSF-290 / BFSF-291).
 *
 * Super-admin edge case: req.session.isAdmin users may have no
 * organizationId binding at all (organizationId === '' on the admin seed
 * account). They still chat through this route and need the shield to
 * apply, otherwise PII detection, moderation and the web search guard all
 * silently no-op for the highest-privilege user. Fall back to the single org
 * shield when exactly one exists; with several orgs there is no guessing.
 */
async function resolveTurnShield(req, { userOrgId, userId }) {
    const { resolveShieldFor } = require('../../../core/privacy/orgShield');
    let orgShield = await resolveShieldFor({ orgId: userOrgId, userId });
    let shieldSource = orgShield ? (userOrgId ? `org ${userOrgId}` : `user ${userId}`) : 'none';
    if (!orgShield?.enabled && req.session?.isAdmin) {
        const allConfigs = await configStore.getAllConfig() || {};
        const shieldKeys = Object.keys(allConfigs).filter(k => k.startsWith('org_privacy_shield_'));
        if (shieldKeys.length === 1) {
            // Resolve it properly (tier clamps + legacy field mapping) rather
            // than handing the raw stored doc downstream.
            const soleOrgId = shieldKeys[0].replace(/^org_privacy_shield_/, '');
            const { resolveOrgShield } = require('../../../core/privacy/orgShield');
            orgShield = await resolveOrgShield(soleOrgId) || allConfigs[shieldKeys[0]];
            shieldSource = `sole-org ${soleOrgId} (super-admin)`;
            log.info(`[DirectChat] Super-admin without org binding — using sole org shield ${shieldKeys[0]}`);
        } else if (shieldKeys.length > 1) {
            log.info(`[DirectChat] Super-admin without org binding and ${shieldKeys.length} shields exist — no shield applied (set organizationId on the admin user or add an org picker)`);
        }
    }
    return { orgShield, shieldSource };
}

/**
 * Inject moderation-violation context into the volatile block so the AI can
 * explain, and strip the violating user message: only a placeholder goes to
 * the model.
 * @param {(value: string) => void} appendVolatile
 * @param {ChatMessage[]} messages
 */
function applyModerationViolation(messages, appendVolatile) {
    appendVolatile(`\n\n[IMPORTANT: The user's message was flagged by our content safety policy. You must briefly explain that their message could not be processed because it was flagged by our content policy, and politely ask them to rephrase. Keep your response short (1-2 sentences). Do not reveal the specific violation category. Do not process or answer the original request.]`);
    const lastMsg = messages[messages.length - 1];
    if (lastMsg?.role === 'user') {
        if (typeof lastMsg.content === 'string') {
            lastMsg.content = `[Message flagged by content moderation]`;
        } else if (Array.isArray(lastMsg.content)) {
            // Multimodal message: replace only text parts, keep structure
            lastMsg.content = lastMsg.content.map(part =>
                part.type === 'text' ? { type: 'text', text: '[Message flagged by content moderation]' } : part
            );
        }
    }
}

module.exports = { stripUnicodeSmuggling, logUnicodeSmuggling, resolveTurnOrgId, resolveTurnShield, applyModerationViolation };
