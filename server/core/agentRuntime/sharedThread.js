/**
 * Streaming agent chat — shared project-thread collaboration.
 *
 * The project-feed announcer and the per-conversation turn lock for threads
 * shared with a project: an editor may post, a viewer may not, and only one
 * AI run holds the turn at a time. Moved verbatim out of chatStream.js; the
 * release callback is parked in the caller's `_pendingTurnReleases` map,
 * whose single `finally` in chatWithAgentStream runs it.
 */
/**
 * Announce a shared-thread event to its project feed.
 *
 * Persist first — the row is what assigns the gapless per-project sequence, and
 * subscribers read forward from their cursor rather than trusting the
 * notification's payload. Best-effort: the live feed must never fail the turn.
 */
const log = require('../../telemetry/log');
function _emitAgentThreadEvent(projectId, event) {
    return require('../projectFeed').emitProjectEvent(projectId, event, { label: 'AgentRuntime' });
}

async function setupSharedThreadTurnLock({ conversation, isEphemeral, userId, _pendingTurnReleases, _turnCallId }) {
    // ── Shared project thread: permission + turn lock ────────────
    // Same contract as the direct-chat path: a project editor may post into a
    // shared thread, a viewer may not, and only one AI run runs at a time so two
    // members cannot interleave two half-answers. Wrapped so the collaboration
    // layer can never block an ordinary agent chat.
    let _turnLock = null;
    let _sharedThread = null;
    if (!isEphemeral && conversation?.id) {
        try {
            const { resolveConversationAccess } = require('../../stores/agent/conversationAccess');
            const access = await resolveConversationAccess(conversation.id, userId, 'agent');
            if (access && access.sharedScope === 'project') {
                if (!access.canPost) {
                    throw Object.assign(new Error('You have view-only access to this conversation.'), {
                        code: 'CONVERSATION_READ_ONLY',
                    });
                }
                _sharedThread = access;
                const lockStore = require('../../stores/conversationLockStore');
                const runId = `run_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
                const claim = await lockStore.acquireTurn({
                    conversationId: conversation.id,
                    conversationType: 'agent',
                    projectId: access.projectId,
                    userId,
                    runId,
                });
                if (!claim.acquired) {
                    throw Object.assign(
                        new Error('Another member is asking the AI in this conversation. Try again in a moment.'),
                        { code: 'TURN_BUSY', holderUserId: claim.holder?.holderUserId || null }
                    );
                }
                _turnLock = { conversationId: conversation.id, runId };
                await _emitAgentThreadEvent(access.projectId, {
                    kind: 'run.started', actorId: userId,
                    targetType: 'conversation', targetId: conversation.id,
                });
            }
        } catch (lockErr) {
            if (lockErr.code === 'CONVERSATION_READ_ONLY' || lockErr.code === 'TURN_BUSY') throw lockErr;
            log.warn('[AgentRuntime] shared-thread setup failed:', lockErr.message);
        }
    }
    // Park the release with the wrapper, which owns the one `finally` every
    // completion branch of this function passes through. Registered right after
    // the claim so nothing between here and the loop can strand the lock.
    if (_turnLock && _turnCallId) {
        _pendingTurnReleases.set(_turnCallId, async () => {
            const lock = _turnLock;
            _turnLock = null;
            if (!lock) return;
            await require('../../stores/conversationLockStore').releaseTurn(lock);
            if (_sharedThread) {
                await _emitAgentThreadEvent(_sharedThread.projectId, {
                    kind: 'run.finished', actorId: userId,
                    targetType: 'conversation', targetId: lock.conversationId,
                });
            }
        });
    }

    return { _sharedThread };
}

module.exports = { _emitAgentThreadEvent, setupSharedThreadTurnLock };
