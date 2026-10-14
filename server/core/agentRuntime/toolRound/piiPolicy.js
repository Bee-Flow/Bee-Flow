// @typecheck
/**
 * The data-protection steps on a tool call's ARGUMENTS: the org tool-PII
 * policy for the tool's class, the DLP restore of tokenised values, the regex
 * guardrail on the tool input, and the pre-dispatch tool-PII block (which
 * generalises the Web Search Guard). Moved verbatim out of the per-call
 * closure of executeToolRound (../toolRoundExecutor.js), which runs them in
 * this order: policy, restore, (tool_start, abort check), regex, PII block.
 *
 * `deps` carries what sits in the server's large import cycle (orgShield,
 * dlpRunner, applyTokenMapToOutbound, piiDetection) as lazy getters, so this
 * module stays out of the cycle and nothing loads earlier than it did.
 */
const guardrailEventStore = require('../../../stores/guardrailEventStore');
const { checkRegexPatterns } = require('../../privacy/guardrails');
const { isCustomTypeId } = require('../../privacy/customTypes/ids');
const testChatMod = require('../testChat');
const log = require('../../../telemetry/log');

/**
 * The org tool-PII policy for this tool's CLASS. Read before the DLP restore,
 * on the arguments as the model wrote them, exactly as before.
 * @returns {{ _toolClass: string, _piiThreshold: number, _blockCats: Set<string> }}
 */
function resolveToolPiiPolicy(rc, deps, toolName, toolArgs) {
    const { dlpShield, webSearchGuardEnabled, webSearchGuardPiiCategories } = rc;
    // Org tool-PII policy for this tool's CLASS (external = data leaves
    // the box, internal = on-box). Resolved once per tool call and
    // reused by the pre-dispatch block check AND the result-redaction
    // step below. classifyToolClass lives in orgShield (single source
    // of truth shared with the admin route/UI).
    const { classifyToolClass: _classifyToolClass } = deps.orgShield();
    const _toolClass = _classifyToolClass(toolName, toolArgs);
    const _piiThreshold = (typeof dlpShield?.piiDetectionConfidenceThreshold === 'number')
        ? dlpShield.piiDetectionConfidenceThreshold : 0.7;
    const _blockCats = new Set((dlpShield?.toolPiiPolicy?.[_toolClass]?.blockCategories) || []);
    // Legacy Web Search Guard: its category list still BLOCKS external
    // tools, but only when the guard is actually enabled. Orgs that
    // picked categories with the guard DISABLED stay monitor-only
    // (logged, not blocked) — handled in the guard below.
    if (_toolClass === 'external' && webSearchGuardEnabled && Array.isArray(webSearchGuardPiiCategories)) {
        for (const c of webSearchGuardPiiCategories) _blockCats.add(c);
    }
    return { _toolClass, _piiThreshold, _blockCats };
}

/** Put the real values back into tokenised arguments (best-effort). */
function restoreDlpArgs(rc, deps, toolArgs) {
    const { conversation } = rc;
    const { untokeniseToolArgs } = deps;
    // Restore DLP tokens in outbound tool args so EVERY tool —
    // including web/agent search — receives the real value, not the
    // [email_1] placeholder (BFSF-171). The block policy above is now
    // the only thing that withholds PII from a tool.
    try {
        const _argMap = deps.dlpRunner().getConversationTokenMap(conversation?.id);
        if (_argMap && Object.keys(_argMap).length) toolArgs = untokeniseToolArgs(toolArgs, _argMap);
    } catch (_) { /* best-effort: leave args tokenized on error */ }
    return toolArgs;
}

/** Regex guardrails, tool-input scope. Returns the sentinel, or null. */
function regexInputGuard(rc, { toolCall, toolName, toolArgs }) {
    const { onEvent, regexConfig } = rc;
    // Regex Guardrails - Tool Input scope
    if (regexConfig?.enabled && regexConfig?.scope?.toolInput) {
        const matches = checkRegexPatterns(JSON.stringify(toolArgs), regexConfig.rulesWithNames);
        if (matches.length > 0) {
            const ruleNames = matches.map(m => m.ruleName).join(', ');
            log.info(`[RegexGuard] Tool input violated rules: ${ruleNames}`);
            onEvent('tool_end', { name: toolName, result: `[Tool input blocked - violates ${ruleNames} policy]` });
            return {
                toolCall,
                toolName,
                toolArgs,
                finalToolResult: `[Tool input blocked - violates ${ruleNames} policy]`,
                blocked: true
            };
        }
    }
    return null;
}

/**
 * The categories a search tool is MONITORED for (logged, allowed) when the
 * legacy guard is configured but disabled, or null. The caller only runs the
 * (awaited) argument scan when this or the block list asks for one.
 */
function monitorCategoriesFor(rc, toolName) {
    const { webSearchGuardEnabled, webSearchGuardPiiCategories } = rc;
    const _isSearchTool = /^(agent_search|web_search|search|brave_search|browse_web|read_url)$/i.test(toolName || '');
    const _monitorCats = (_isSearchTool && !webSearchGuardEnabled
        && Array.isArray(webSearchGuardPiiCategories) && webSearchGuardPiiCategories.length)
        ? webSearchGuardPiiCategories : null;
    return _monitorCats;
}

/**
 * The pre-dispatch tool-PII block on the (restored) arguments. Returns the
 * sentinel result for a refused call, or null when it may go on.
 */
async function checkArgumentPii(rc, deps, { toolCall, toolName, toolArgs, policy, _monitorCats }) {
    const {
        onEvent, dlpShield, userId, agent, agentId, conversation, modelToUse, messageMetadata,
    } = rc;
    const { _toolClass, _piiThreshold, _blockCats } = policy;
    const { detectPii } = deps.piiDetection();
    const _checkCats = [...new Set([..._blockCats, ...(_monitorCats || [])])];
    let _argPii = null, _guardErr = false;
    try {
        _argPii = await detectPii(JSON.stringify(toolArgs || {}), _checkCats, _piiThreshold);
    } catch (e) {
        _guardErr = true;
        log.warn('[ToolPiiGuard] arg PII check failed:', e.message);
    }
    // A degraded scan is NOT a clean scan. detectPii returns
    // { degraded: true, entities: [] } WITHOUT throwing when the
    // guard is unreachable or the model isn't loaded, so treating
    // only thrown errors as failure let a degraded result fall
    // through to `_argPii?.hasPii === false` and dispatch the tool
    // with unredacted args. That is an egress path, and it gets
    // strictly worse under GLiNER-only: today a degraded response
    // still carries regex hits, afterwards it carries nothing.
    // (detectPii returning null means the guard isn't installed at
    // all — that stays fail-open, matching every other consumer.)
    if (!_guardErr && _argPii?.degraded) {
        _guardErr = true;
        log.warn('[ToolPiiGuard] arg PII scan degraded:',
            _argPii.degradedReason || 'unknown');
    }

    if (_guardErr) {
        // Fail-closed ONLY for block-action orgs with an active block
        // list; otherwise fail-open (matches the legacy guard).
        if (_blockCats.size > 0 && dlpShield?.privacyAction === 'block') {
            onEvent('tool_end', { name: toolName, result: `[Tool blocked — PII guard unavailable (fail-closed)]` });
            return {
                toolCall, toolName, toolArgs,
                finalToolResult: `[Tool '${toolName}' was not called: the PII guard is unavailable and org policy fails closed. Ask the user to retry shortly.]`,
                blocked: true,
            };
        }
        // else fall through and execute (fail-open)
    } else if (_argPii?.hasPii) {
        // A span an org's own data type won still carries
        // the built-in categories it covered (alsoCategories).
        const _hitsAny = (e, cats) => cats.has(e.category)
            || (Array.isArray(e.alsoCategories) && e.alsoCategories.some(c => cats.has(c)));
        const _logLabel = (e) => (isCustomTypeId(e.category) ? e.category : e.label);
        const _blockedHits = _argPii.entities.filter(e => _hitsAny(e, _blockCats));
        if (_blockedHits.length > 0) {
            const _labels = [...new Set(_blockedHits.map(e => e.label))].join(', ');
            guardrailEventStore.logGuardrailEvent({
                organization_id: agent.organization_id || null,
                user_id: userId, agent_id: agentId, agent_name: agent.name,
                conversation_id: conversation?.id || null,
                violation_type: 'pii', violation_categories: _labels,
                direction: 'output', action_taken: 'tool_blocked',
                // Een testbeurt schrijft onder zijn eigen bron en als
                // droogloop — zie testChat.js.
                source: testChatMod.usageSourceFor(messageMetadata, 'agent_stream'),
                is_dry_run: testChatMod.isDryRunTurn(messageMetadata),
                model: modelToUse,
            }).catch(() => {});
            log.info(`[ToolPiiGuard] '${toolName}' (${_toolClass}) BLOCKED — args contain ${[...new Set(_blockedHits.map(_logLabel))].join(', ')}`);
            onEvent('tool_end', { name: toolName, result: `[Tool blocked — arguments contain sensitive information (${_labels})]` });
            return {
                toolCall, toolName, toolArgs,
                finalToolResult: `[Tool '${toolName}' was not called: its arguments contained ${_labels}, which org policy forbids sending to ${_toolClass} tools. Continue without that information or ask the user how to proceed.]`,
                blocked: true,
            };
        }
        // Monitor-only (search guard configured but disabled): log, allow.
        if (_monitorCats) {
            const _monHits = _argPii.entities.filter(e => _hitsAny(e, new Set(_monitorCats)));
            if (_monHits.length > 0) {
                const _monLabels = [...new Set(_monHits.map(e => e.label))].join(', ');
                guardrailEventStore.logGuardrailEvent({
                    organization_id: agent.organization_id || null,
                    user_id: userId, agent_id: agentId, agent_name: agent.name,
                    conversation_id: conversation?.id || null,
                    violation_type: 'pii', violation_categories: _monLabels,
                    direction: 'output', action_taken: 'pii_detected',
                    source: testChatMod.usageSourceFor(messageMetadata, 'agent_stream'),
                    is_dry_run: testChatMod.isDryRunTurn(messageMetadata),
                    model: modelToUse,
                }).catch(() => {});
                log.info(`[ToolPiiGuard] PII in ${toolName} args (${[...new Set(_monHits.map(_logLabel))].join(', ')}) — monitor-only, allowed`);
            }
        }
    }
    return null;
}

module.exports = {
    resolveToolPiiPolicy, restoreDlpArgs, regexInputGuard, monitorCategoriesFor, checkArgumentPii,
};
