import type { SseHandlerMap } from '../handlerTypes';

/**
 * Chat-local session skills: bootstrap, snapshot updates and per-step
 * completions.
 */
export const sessionHandlers: SseHandlerMap = {
    session_skills_bootstrap_started(ctx, _data, ids) {
        const { setMessages } = ctx;
        const { assistantMsgId } = ids;
        // Tag the in-flight assistant message so MessageItem can show a
        // "Preparing chat-local skills…" status above the reply.
        setMessages(prev => prev.map(m =>
            m.id === assistantMsgId
                ? { ...m, sessionSkillsBootstrap: { state: 'pending' } }
                : m
        ));
    },

    session_skills_bootstrapped(ctx, data, ids) {
        const { setMessages, onSessionSkillsChanged } = ctx;
        const { assistantMsgId } = ids;
        if (Array.isArray(data.skills)) {
            const skills = data.skills;
            const snapIds = Array.isArray(data.activatedSkillIds) ? data.activatedSkillIds : [];
            setMessages(prev => prev.map(m =>
                m.id === assistantMsgId
                    ? {
                        ...m,
                        sessionSkillsBootstrap: {
                            state: 'done',
                            skills: skills.map(s => ({
                                id: s.id,
                                name: s.name,
                                description: s.description || '',
                                icon: s.icon || '🧩',
                            })),
                        },
                        // Stamp the snapshot immediately so the timeline
                        // stays pinned to this state after streaming ends
                        // (before server persist round-trips).
                        sessionSkillsSnapshot: {
                            activatedSkillIds: [...snapIds],
                            completedSkillIds: [],
                            completions: [],
                        },
                    }
                    : m
            ));
            onSessionSkillsChanged?.({
                skills: data.skills,
                activatedSkillIds: snapIds,
                completedSkillIds: [],
            });
        }
    },

    session_skills_updated(ctx, data, ids) {
        const { setMessages, onSessionSkillsChanged } = ctx;
        const { assistantMsgId } = ids;
        if (Array.isArray(data.skills)) {
            const skills = data.skills;
            const snapIds = Array.isArray(data.activatedSkillIds) ? data.activatedSkillIds : [];
            const completedIds = Array.isArray(data.completedSkillIds) ? data.completedSkillIds : null;
            // Stamp the latest snapshot onto the in-flight assistant
            // message so a post-stream view keeps the full state even
            // before the server persists/reloads.
            setMessages(prev => prev.map(m => {
                if (m.id !== assistantMsgId) return m;
                const prevSnap = m.sessionSkillsSnapshot || {};
                return {
                    ...m,
                    sessionSkillsSnapshot: {
                        ...prevSnap,
                        activatedSkillIds: [...snapIds],
                        ...(completedIds ? { completedSkillIds: [...completedIds] } : {}),
                    },
                };
            }));
            onSessionSkillsChanged?.({
                skills: data.skills,
                activatedSkillIds: snapIds,
                ...(completedIds ? { completedSkillIds: completedIds } : {}),
            });
        }
    },

    session_skill_completed(ctx, data, ids) {
        const { setMessages } = ctx;
        const { assistantMsgId } = ids;
        // Per-step completion — append to the in-flight message's
        // completions list so the timeline renders a "✓ Step — summary"
        // row live as the pipeline walks.
        if (data && data.skillId) {
            setMessages(prev => prev.map(m => {
                if (m.id !== assistantMsgId) return m;
                const prevSnap = m.sessionSkillsSnapshot || {};
                const prevCompletions = Array.isArray(prevSnap.completions) ? prevSnap.completions : [];
                const prevCompletedIds = Array.isArray(prevSnap.completedSkillIds) ? prevSnap.completedSkillIds : [];
                return {
                    ...m,
                    sessionSkillsSnapshot: {
                        ...prevSnap,
                        completions: [...prevCompletions, data],
                        completedSkillIds: prevCompletedIds.includes(data.skillId)
                            ? prevCompletedIds
                            : [...prevCompletedIds, data.skillId],
                    },
                };
            }));
        }
    },
};
