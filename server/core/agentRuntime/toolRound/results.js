// @typecheck
/**
 * The second half of a tool round, once every call has settled: the
 * concurrent PII pre-scan of the results, then the in-order result loop —
 * history and timeline, tool_end, the side channels (./sideChannels.js), the
 * usage row, the success egress row, the result redaction + tokenisation, and
 * the tool message for both history arrays. Moved verbatim out of
 * executeToolRound (../toolRoundExecutor.js), which persists afterwards.
 *
 * `deps` carries what sits in the server's large import cycle (piiDetection,
 * dlpRunner, toolResultRedact, integrationLogging, usageStore, the custom
 * type plan, the tool-class lookup) as lazy getters or values, so this module
 * stays out of the cycle and nothing loads earlier than it did.
 */
const { sanitizeToolResult } = require('../../../utils/sanitize');
const guardrailEventStore = require('../../../stores/guardrailEventStore');
const { MAX_TOOL_CONTENT_BYTES, buildLLMToolContent, truncateToolContent } = require('./toolContent');
const { emitSideChannels } = require('./sideChannels');
const testChatMod = require('../testChat');
const log = require('../../../telemetry/log');
const { bestEffort } = require('../../../utils/bestEffort');

/**
 * Pre-scan, then process every result in call order. Pushes the tool
 * messages onto `rc.messages` and `rc.durableMessages`.
 */
async function processToolResults(rc, deps, toolResults) {
    const { dlpShield, onEvent, toolCalls, messages, durableMessages, _toolHistory } = rc;
    const _preScans = await preScanToolResults(rc, deps, toolResults);

    // Process results in order
    for (let _resIdx = 0; _resIdx < toolResults.length; _resIdx++) {
        const result = toolResults[_resIdx];
        const _preScan = _preScans[_resIdx];
        const { toolCall, toolName, toolArgs, finalToolResult } = result;

        toolCalls.push({ name: toolName, args: toolArgs, result: finalToolResult });
        // Track for persistence
        _toolHistory.push({
            name: toolName,
            args: toolArgs,
            status: 'done',
            resultPreview: (typeof finalToolResult === 'string' ? finalToolResult : JSON.stringify(finalToolResult || '')).slice(0, 200),
        });
        // Sanitize tool result before streaming to client to prevent API key exposure
        onEvent('tool_end', { name: toolName, result: sanitizeToolResult(finalToolResult) });

        emitSideChannels(rc, deps, { toolName, finalToolResult });

        await logToolUsageRow(rc, deps, toolName);

        // ONLY for successfully-dispatched calls: blocked sentinels either
        // never dispatched (no bytes left — a row would be fabricated egress)
        // or errored inside the map closure, where the error path already
        // wrote a status='error' row. Logging them here again produced double
        // rows and false 'success' statuses.
        if (result.blocked !== true) logSuccessEgress(rc, deps, result, _preScan);

        let _toolContent = _preScan ? _preScan.content : buildLLMToolContent(finalToolResult);
        if (dlpShield?.enabled && _preScan && !_preScan.failed) {
            _toolContent = redactToolResultContent(rc, deps, result, _preScan, _toolContent);
        }
        // Real history: later turns read pruned tool results back out
        // of the transcript, and the UI filters them out on render.
        const toolMsg = {
            role: 'tool',
            tool_call_id: toolCall.id,
            content: _toolContent,
        };
        messages.push(toolMsg);
        durableMessages.push(toolMsg);
    }
}

/**
 * privacy_scan_knowledge_bases=false: the org does not want knowledge-base
 * content tokenised. Such a result is still held to the tool class's block
 * list (strip, never tokenise).
 */
function kbTokenisingOff(dlpShield, r) {
    return dlpShield?.privacy_scan_knowledge_bases === false
        && (r.finalToolResult?._action === 'kb_sources' || r.toolName === 'kb_search');
}

/**
 * Pre-scan tool results for PII, CONCURRENTLY. Resolves to one entry per
 * result (null when not scanned).
 *
 * The redaction scan used to sit inside the sequential result loop, so N
 * tool results meant N serialised guard round-trips of up to
 * MAX_TOOL_CONTENT_BYTES each, all on the critical path before the next model
 * round. Hoisting it here overlaps them; the loop stays sequential so
 * ordering, the token map and conversation bookkeeping are untouched.
 *
 * Bounded deliberately. The guard's own semaphore is 2
 * (GUARD_PII_MAX_CONCURRENCY), so an unbounded fan-out would not finish
 * sooner — it would queue there, and a 10-tool round would hold both slots
 * and push a CONCURRENT user's pre-first-token scan behind the whole burst.
 */
async function preScanToolResults(rc, deps, toolResults) {
    const { dlpShield } = rc;
    const { scanCategoriesFor, toolClassOf: _toolClassOf } = deps;
    const _TOOL_SCAN_CONCURRENCY = 3;
    const _preScans = new Array(toolResults.length).fill(null);
    if (!dlpShield?.enabled) return _preScans;
    const { detectPii: _detectPii } = deps.piiDetection();
    const _preThreshold = (typeof dlpShield.piiDetectionConfidenceThreshold === 'number')
        ? dlpShield.piiDetectionConfidenceThreshold : 0.7;
    let _nextIdx = 0;
    const _scanWorker = async () => {
        for (;;) {
            const i = _nextIdx++;
            if (i >= toolResults.length) return;
            const content = buildLLMToolContent(toolResults[i].finalToolResult);
            if (typeof content !== 'string' || content.length === 0) continue;
            const scanStr = content.slice(0, MAX_TOOL_CONTENT_BYTES);
            const entry = { content, scanStr, threshold: _preThreshold, pii: null, failed: false };
            try {
                // Every built-in category, as before, plus the
                // org's own data types that are hidden from the
                // AI or blocked for this tool's class.
                const _kbOff = kbTokenisingOff(dlpShield, toolResults[i]);
                const _resBlock = Array.isArray(toolResults[i].blockCats) ? toolResults[i].blockCats : [];
                if (_kbOff && _resBlock.length === 0) continue; // nothing to strip, nothing to tokenise
                const _resCats = _kbOff ? _resBlock : scanCategoriesFor(dlpShield, _toolClassOf(toolResults[i].toolName));
                entry.pii = await _detectPii(scanStr, _resCats, _preThreshold);
            } catch (e) {
                // Fail-open, exactly as the in-loop version did.
                entry.failed = true;
                log.warn('[ToolResultDlp] result scan failed (fail-open):', e.message);
            }
            _preScans[i] = entry;
        }
    };
    await Promise.all(
        Array.from({ length: Math.min(_TOOL_SCAN_CONCURRENCY, toolResults.length) },
                   () => _scanWorker()),
    );
    return _preScans;
}

/**
 * Log tool invocation for the per-tool dashboard. These rows intentionally
 * carry zero token counts — tool execution doesn't consume model tokens.
 * Cost-bearing queries (summary, by-model, by-source) filter
 * `tool_name IS NULL` so these rows don't inflate call count or distort cost.
 */
async function logToolUsageRow(rc, deps, toolName) {
    const { userId, agent, agentId, conversation, modelToUse, messageMetadata } = rc;
    try {
        await deps.usageStore.logUsage({
            user_id: userId,
            agent_id: agentId,
            agent_name: agent.name,
            agent_type: 'chat',
            model: modelToUse,
            tool_name: toolName,
            source: testChatMod.usageSourceFor(messageMetadata, 'agent_chat'),
            organization_id: agent.organization_id || null,
            conversation_id: conversation?.id || null,
            parent_call_id: messageMetadata.parentCallId || null,
        });
    } catch (e) { bestEffort('core/agentRuntime/toolRound/results:logToolUsageRow', e); /* ignore */ }
}

/**
 * Integration Activity Logging (async, non-blocking). One shared write path
 * (core/integrationLogging.js): the minimal metadata row is ALWAYS written;
 * the org's monitorIntegrations toggle only gates the PII scan.
 */
function logSuccessEgress(rc, deps, result, _preScan) {
    const { dlpShield, userAuth, userId, agent, agentId, conversation, modelToUse, messageMetadata, _lentByToolCall } = rc;
    const { scanCategoriesFor, toolClassOf: _toolClassOf } = deps;
    const { toolCall, toolName, toolArgs, finalToolResult, outboundProbe } = result;
    try {
        const { logToolEgress } = deps.integrationLogging();
        const resultText = typeof finalToolResult === 'string' ? finalToolResult : JSON.stringify(finalToolResult || '');
        const _lent = _lentByToolCall.get(toolCall.id) || null;
        logToolEgress({
            toolName,
            toolArgs,
            result: finalToolResult,
            probe: outboundProbe || null,
            source: testChatMod.usageSourceFor(messageMetadata, 'agent_stream'),
            isDryRun: testChatMod.isDryRunTurn(messageMetadata),
            model: modelToUse,
            durationMs: result.dispatchMs,
            session: userAuth?.session || null,
            ids: {
                organization_id: agent.organization_id || null,
                user_id: userId,
                agent_id: agentId,
                agent_name: agent.name,
                conversation_id: conversation?.id || null,
                // Borrowed-connection attribution (null for bring-your-own runs).
                acting_user_id: _lent ? _lent.integrationUserId : null,
                connection_id: _lent ? _lent.connectionId : null,
                grant_id: _lent ? _lent.grantId : null,
            },
            // Reuse the redaction scan instead of issuing a SECOND guard
            // call for the same bytes. Both scan with categories=null, so
            // when the thresholds agree and this text is genuinely a prefix
            // of what was already scanned, the entities within range are
            // exactly what a fresh scan would return.
            //
            // The prefix is CHECKED, not assumed: buildLLMToolContent()
            // strips underscore-prefixed and noise keys and can restructure
            // an object result, so _preScan.scanStr equals resultText only
            // for plain-string tool results.
            //
            // Deliberately NOT "fixed" by auditing _preScan.content instead:
            // that is what reaches the MODEL, whereas this row audits what
            // came through the INTEGRATION. Stripped `_`-prefixed / UI-only
            // fields can carry PII that reaches the user but not the model.
            fullScan: async (_payloadText, threshold) => {
                const logText = resultText.slice(0, 5000);
                if (_preScan && !_preScan.failed && _preScan.pii
                    && _preScan.threshold === threshold
                    && _preScan.scanStr.startsWith(logText)) {
                    const entities = (_preScan.pii.entities || [])
                        .filter(e => e.offset + e.length <= logText.length);
                    return { hasPii: entities.length > 0, entities };
                }
                const { detectPii } = deps.piiDetection();
                return detectPii(logText, scanCategoriesFor(dlpShield, _toolClassOf(toolName)), threshold);
            },
        });
    } catch (e) { bestEffort('core/agentRuntime/toolRound/results:logSuccessEgress', e); /* ignore integration logging errors */ }
}

/**
 * Scan the tool RESULT for PII before the model sees it. Detects "incoming"
 * PII that arrives THROUGH a tool (web-search hits, contacts, calendar
 * attendees, KB chunks via kb_search…):
 *   (a) drop blocked-category PII — the refuse-class policy applies to
 *       incoming data too;
 *   (b) tokenize the remaining PII into the conversation map so it
 *       round-trips: restored for the user on the response stream
 *       (createUntokeniser) and restored to real values if the model later
 *       passes it into another tool (untokeniseToolArgs).
 * Fail-open everywhere: never drop the turn over a scan error. Returns the
 * content the model reads (`content` unchanged when nothing was found).
 */
function redactToolResultContent(rc, deps, result, _preScan, content) {
    const { dlpShield, userId, agent, agentId, conversation, modelToUse, messageMetadata } = rc;
    const { toolName } = result;
    const _resBlockCats = new Set(Array.isArray(result.blockCats) ? result.blockCats : []);
    try {
        const _dlpRunner = deps.dlpRunner();
        const { redactAndTokenizeToolResult } = deps.toolResultRedact();
        const _scanStr = _preScan.scanStr;
        const _resPii = _preScan.pii;      // scanned concurrently above
        // KB result with tokenising off: only blocked categories count.
        if (_resPii?.entities && kbTokenisingOff(dlpShield, result)) {
            _resPii.entities = _resPii.entities.filter(e => _resBlockCats.has(e.category)
                || (Array.isArray(e.alsoCategories) && e.alsoCategories.some(c => _resBlockCats.has(c))));
        }
        if (!(_resPii?.hasPii && _resPii.entities?.length)) return content;
        const _existing = _dlpRunner.getConversationTokenMap(conversation?.id) || {};
        const _r = redactAndTokenizeToolResult(_scanStr, _resPii.entities, _resBlockCats, _existing);
        // Merge result-minted tokens into the conv map (round-trip + DB write-through).
        if (_r.tokenMap && Object.keys(_r.tokenMap).length) _dlpRunner.mergeTokenMap(conversation?.id, _r.tokenMap);
        if (_r.blockedCount > 0) {
            guardrailEventStore.logGuardrailEvent({
                organization_id: agent.organization_id || null,
                user_id: userId, agent_id: agentId, agent_name: agent.name,
                conversation_id: conversation?.id || null,
                violation_type: 'pii', violation_categories: _r.redactedLabels.join(', '),
                direction: 'input', action_taken: 'tool_result_redacted',
                source: testChatMod.usageSourceFor(messageMetadata, 'agent_stream'),
                is_dry_run: testChatMod.isDryRunTurn(messageMetadata),
                model: modelToUse,
            }).catch((e) => bestEffort('core/agentRuntime/toolRound/results:redactToolResultContent', e));
            log.info(`[ToolResultDlp] '${toolName}' result redacted (${(_r.redactedLogLabels || []).join(', ')})`);
        }
        // tokenize-then-truncate so a [token] span is never split.
        return truncateToolContent(_r.content);
    } catch (e) {
        log.warn('[ToolResultDlp] result scan failed (fail-open):', e.message);
        return content;
    }
}

module.exports = { processToolResults };
