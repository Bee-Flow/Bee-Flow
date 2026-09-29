/**
 * Direct Chat — posting into a conversation shared with a project.
 *
 * Two things follow from a thread more than one person can post into: the
 * caller's right to post has to be checked (the store's owner predicate is no
 * longer the whole answer), and only one AI run may be in flight per thread,
 * or two senders interleave two half-answers to two questions.
 *
 * Returns false when it has already answered the response; the caller then
 * stops. Moved verbatim out of streamTurn.js.
 */

const { emitThreadEvent } = require('./shared');
const log = require('../../../telemetry/log');

async function claimSharedThreadTurn(turn) {
    const { res, send, userId } = turn;
    if (!turn.convId) return true;
    try {
        const { resolveConversationAccess } = require('../../../stores/agent/conversationAccess');
        const access = await resolveConversationAccess(turn.convId, userId, 'direct');
        if (access && access.sharedScope === 'project') {
            if (!access.canPost) {
                send('error', { error: 'You have view-only access to this conversation.' });
                res.end();
                return false;
            }
            turn._sharedThread = access;

            const lockStore = require('../../../stores/conversationLockStore');
            const runId = `run_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
            const claim = await lockStore.acquireTurn({
                conversationId: turn.convId,
                conversationType: 'direct',
                projectId: access.projectId,
                userId,
                runId,
            });
            // Contention is a QUEUE, not an error: the second sender is told
            // who is talking and asked to retry. A hard 409 on a shared thread
            // reads as "the app is broken" rather than "someone else is
            // speaking".
            if (!claim.acquired) {
                send('turn_busy', {
                    holderUserId: claim.holder?.holderUserId || null,
                    conversationId: turn.convId,
                });
                res.end();
                return false;
            }
            turn._turnLock = { conversationId: turn.convId, runId };

            await emitThreadEvent(access.projectId, {
                kind: 'run.started', actorId: userId,
                targetType: 'conversation', targetId: turn.convId,
            });
        }
    } catch (lockErr) {
        // Never let the collaboration layer block an ordinary chat.
        log.warn('[DirectChat] shared-thread setup failed:', lockErr.message);
    }
    return true;
}

module.exports = { claimSharedThreadTurn };
