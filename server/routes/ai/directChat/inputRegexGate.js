// @typecheck
/**
 * Direct Chat input gates, part three: the regex guardrails. The org shield's
 * rules merged with the direct-chat-specific collection, checked against the
 * typed message and applied (redact / block) to what the model receives.
 * Split out of inputGates.js; behaviour unchanged.
 */

const configStore = require('../../../stores/configStore');
const { getAIConfig } = require('../../../core/aiAgent');
const { applyRegexGuardrails } = require('../../../core/agentRuntime/guardrailsRunner');
const log = require('../../../telemetry/log');

/** The direct-chat-specific regex guardrails, from the global rule collections. */
async function directChatRegexConfig() {
    const dcRegexConfig = await configStore.getConfig('direct_chat_regex_guardrails');
    if (!dcRegexConfig?.enabled) return null;
    const globalConfig = await getAIConfig();
    const globalRegexConfig = globalConfig.regexGuardrails || {};
    const globalRules = globalRegexConfig.rules || [];
    const globalCollections = globalRegexConfig.collections || [];

    const rulesWithNames = [];
    for (const colId of dcRegexConfig.collectionIds || []) {
        const collection = globalCollections.find(c => c.id === colId);
        if (!collection) continue;
        for (const ruleId of collection.ruleIds || []) {
            const rule = globalRules.find(r => r.id === ruleId);
            if (rule?.pattern) rulesWithNames.push({ name: rule.name, pattern: rule.pattern });
        }
    }
    const scope = dcRegexConfig.scope || { userInput: true, agentOutput: true };
    const action = dcRegexConfig.action || 'delete';
    return rulesWithNames.length > 0 ? { enabled: true, rulesWithNames, scope, action } : null;
}

/** The merged regex config for the turn: the turn's shield plus the direct-chat guardrails. */
async function resolveRegexConfig(orgShield, shieldSource) {
    // Reuse the shield resolved at the top of the turn (org shield for
    // org-bound users, personal user shield for consumer accounts).
    if (orgShield) {
        log.info(`[DirectChat] Privacy Shield active for ${shieldSource} (${orgShield.rulesWithNames?.length || 0} rules)`);
    }
    const { mergeWithOrgShield } = require('../../../core/privacy/orgShield');
    return mergeWithOrgShield(orgShield, await directChatRegexConfig());
}

/**
 * Check user input against the regex rules. Match on the typed message, but
 * redact what the model will actually receive: the PII gate or the DLP
 * pre-flight may already have tokenised the last message, and redacting the
 * raw `message` would write the original values back over those tokens (the
 * agent path does the same with redactBase: processedUserMessage). Returns
 * false when the input was blocked (the caller ends the stream).
 */
function applyInputRegex({ messages, message, regexConfig, send }) {
    const lastMsg = messages[messages.length - 1];
    const textPart = Array.isArray(lastMsg?.content) ? lastMsg.content.find(p => p.type === 'text') : null;
    const redactBase = typeof lastMsg?.content === 'string' ? lastMsg.content : (textPart ? textPart.text : message);
    const inputRx = applyRegexGuardrails({ text: message, redactBase, regexConfig, scope: 'userInput', emit: send, direction: 'input' });
    if (inputRx.action !== 'pass') {
        log.info(`[DirectChat RegexGuard] User input violated rules: ${inputRx.ruleNames}, action: ${regexConfig.action}`);
    }
    if (inputRx.action === 'redact') {
        if (typeof lastMsg.content === 'string') {
            lastMsg.content = inputRx.processedText;
        } else if (textPart) {
            textPart.text = inputRx.processedText;
        }
    } else if (inputRx.action === 'block') {
        return false;
    }
    return true;
}

module.exports = { resolveRegexConfig, applyInputRegex };
