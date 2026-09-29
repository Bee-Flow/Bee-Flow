/**
 * Streaming agent chat — SSE-based tool-calling loop with real-time events
 * This is the primary chat function used by the frontend
 *
 * This folder IS the documentation for that turn. The entry point is only the
 * telemetry wrapper and the turn-lock drain; the turn itself is ./turnLoop,
 * and the phases it drives are the files beside it, in pipeline order:
 * ./turnSetup (which agent, model, provider, tools, conversation),
 * ./turnHistory (the prompt array vs the durable one, and the one place they
 * are written), ./turnPreflight (shield, prompt halves, guardrails, DLP,
 * context injection), ./skillActivation (mid-loop tool refresh), then per
 * round ./roundRequest, ./nativeAdapterStream or ./rawSseStream, and
 * ./toolRoundGate — ending in ../finalizeTurn. The neighbouring phases that
 * came out of this file earlier still live one level up (toolStackAssembly,
 * sharedThread, contextEnrichment, attachmentIntake, streamUntokeniser,
 * guardrailHardBlock, toolRoundExecutor, finalizeTurn).
 */
const { recordAgentRun } = require('../../../telemetry/metrics');
const { chatWithAgentStreamImpl, _pendingTurnReleases } = require('./turnLoop');

// Carried over from before this file became a folder: requires the turn no
// longer reads, but that were part of its load graph (module init side
// effects, and the ids the runtime tests stub). Dropping one is a behaviour
// change, so it is a separate, reviewable edit — not part of a move.
require('../../cms/componentManager');
require('../../executionEngine');
require('../../../utils/sanitize');
require('../../integrations/integrationToolMap');
require('../../http/outboundProbe');
require('../../llm/promptClassifier');
require('../../documents/ocr');
require('../../tools/toolExecution');
require('../agentTools');
require('../../llm/promptUtils');
require('../knowledgeSearch');
require('../../../stores/guardrailEventStore');
const log = require('../../../telemetry/log');

// Thin telemetry wrapper: the streaming impl has many completion branches, so
// rather than instrument each return, wrap the whole call to record one
// agent-run metric (ok/error + duration) per invocation. It also owns the one
// `finally` every completion branch passes through, which is where the shared
// project thread's turn lock is released (see ./turnLoop).
let _turnCallSeq = 0;

async function chatWithAgentStream(...args) {
    const _t0 = Date.now();
    let _status = 'ok';
    const callId = `c${++_turnCallSeq}`;
    try {
        return await chatWithAgentStreamImpl(...args, callId);
    } catch (e) {
        _status = 'error';
        throw e;
    } finally {
        const release = _pendingTurnReleases.get(callId);
        _pendingTurnReleases.delete(callId);
        if (release) {
            // Never let a release failure mask the run's own outcome.
            try { await release(); } catch (e) {
                log.warn('[AgentRuntime] turn release failed:', e.message);
            }
        }
        recordAgentRun({ agentType: 'chat_stream', status: _status, durationMs: Date.now() - _t0 });
    }
}

module.exports = { chatWithAgentStream };
