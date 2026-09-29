import SessionSkillsTimeline from './SessionSkillsTimeline';

/**
 * Session-skill pipeline timeline — Standard tier inline tracker.
 * Renders when this assistant message either introduced the pipeline
 * (bootstrap) OR changed its activation state vs the previous assistant turn.
 * Quiet turns get nothing.
 *
 * Lifted verbatim out of MessageItem/index.jsx; the caller still owns the
 * `!isUser && !isTool && chatSource === 'direct' && sessionSkills.length > 0`
 * gate.
 */
const SessionSkillsSection = ({
    msg,
    allMessages,
    sessionSkills,
    liveActivatedSkillIds,
    liveCompletedSkillIds,
    liveCompletions,
}) => {
    // Determine which activation / completion sets to feed the timeline.
    //  - Streaming / last assistant message: live state (fresh SSE updates).
    //  - Any message carrying its own snapshot: use it.
    //  - Otherwise: inherit the nearest prior snapshot (keeps older
    //    messages meaningful even before the per-turn snapshot shipped).
    const myIdx = allMessages.indexOf(msg);
    const isLatestAssistant = myIdx === allMessages.map(m => m?.role === 'assistant').lastIndexOf(true);
    const isLiveTarget = msg.isStreaming || isLatestAssistant;
    const ownSnap = msg.sessionSkillsSnapshot || null;
    let activated;
    let completedIds;
    let completions;
    if (isLiveTarget && Array.isArray(liveActivatedSkillIds)) {
        activated = liveActivatedSkillIds;
        completedIds = Array.isArray(liveCompletedSkillIds) ? liveCompletedSkillIds : (ownSnap?.completedSkillIds || null);
        completions = Array.isArray(liveCompletions) ? liveCompletions : (ownSnap?.completions || []);
    } else if (ownSnap) {
        activated = Array.isArray(ownSnap.activatedSkillIds) ? ownSnap.activatedSkillIds : [];
        completedIds = Array.isArray(ownSnap.completedSkillIds) ? ownSnap.completedSkillIds : null;
        completions = Array.isArray(ownSnap.completions) ? ownSnap.completions : [];
    } else {
        activated = [];
        completedIds = null;
        completions = [];
    }

    // Dedupe: only render on a non-bootstrap message if its
    // snapshot differs from the prior assistant message's
    // (activation OR completion state changed).
    let prevAct = [];
    let prevCompleted = [];
    for (let i = myIdx - 1; i >= 0; i--) {
        const m = allMessages[i];
        const snap = m?.sessionSkillsSnapshot;
        if (m?.role === 'assistant' && Array.isArray(snap?.activatedSkillIds)) {
            prevAct = snap.activatedSkillIds;
            prevCompleted = Array.isArray(snap.completedSkillIds) ? snap.completedSkillIds : [];
            break;
        }
    }
    const sameActivation = prevAct.length === activated.length
        && prevAct.every(id => activated.includes(id));
    const currentCompleted = Array.isArray(completedIds) ? completedIds : [];
    const sameCompletion = prevCompleted.length === currentCompleted.length
        && prevCompleted.every(id => currentCompleted.includes(id));
    const showForBootstrap = !!msg.sessionSkillsBootstrap;
    if (!showForBootstrap && sameActivation && sameCompletion) return null;

    return (
        <SessionSkillsTimeline
            sessionSkills={sessionSkills}
            activatedSkillIds={activated}
            completedSkillIds={completedIds}
            completions={completions}
            bootstrap={msg.sessionSkillsBootstrap || null}
        />
    );
};

export default SessionSkillsSection;
