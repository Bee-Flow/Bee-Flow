import type { SseHandlerMap } from '../handlerTypes';

/**
 * The swarm tier (Deep Research): run, phase and per-worker progress on the
 * in-flight assistant message.
 */
export const swarmHandlers: SseHandlerMap = {
    // ── Swarm tier (Deep Research) ──────────────────────────────
    swarm_started(ctx, data, ids) {
        const { setMessages } = ctx;
        const { assistantMsgId } = ids;
        setMessages(prev => prev.map(m =>
            m.id === assistantMsgId
                ? {
                    ...m,
                    swarm: {
                        state: 'running',
                        swarmId: data.swarmId,
                        swarmName: data.swarmName,
                        phases: Array.isArray(data.phases) ? data.phases : [],
                        phaseStates: {},
                        depth: data.depth || null,
                        startedAt: Date.now(),
                    },
                }
                : m
        ));
    },

    swarm_phase_started(ctx, data, ids) {
        const { setMessages } = ctx;
        const { assistantMsgId } = ids;
        const phaseId = String(data.phaseId);
        setMessages(prev => prev.map(m =>
            m.id === assistantMsgId
                ? {
                    ...m,
                    swarm: {
                        ...(m.swarm || {}),
                        activePhaseId: phaseId,
                        phaseStates: {
                            ...(m.swarm?.phaseStates || {}),
                            [phaseId]: { status: 'active', message: data.message || null, startedAt: Date.now() },
                        },
                    },
                }
                : m
        ));
    },

    swarm_phase_completed(ctx, data, ids) {
        const { setMessages } = ctx;
        const { assistantMsgId } = ids;
        const phaseId = String(data.phaseId);
        setMessages(prev => prev.map(m => {
            if (m.id !== assistantMsgId) return m;
            const prev2 = m.swarm?.phaseStates?.[phaseId] || {};
            return {
                ...m,
                swarm: {
                    ...(m.swarm || {}),
                    phaseStates: {
                        ...(m.swarm?.phaseStates || {}),
                        [phaseId]: { ...prev2, status: 'done', durationMs: data.durationMs || null },
                    },
                },
            };
        }));
    },

    swarm_clarification_required(ctx, data, ids) {
        const { setMessages } = ctx;
        const { assistantMsgId } = ids;
        // The swarm asked the user a follow-up question. Surface it
        // on the in-flight assistant message; the chat UI renders
        // these inline so the user can answer in the next turn.
        setMessages(prev => prev.map(m =>
            m.id === assistantMsgId
                ? {
                    ...m,
                    swarm: {
                        ...(m.swarm || {}),
                        state: 'awaiting_clarification',
                        clarification: {
                            questions: Array.isArray(data?.questions) ? data.questions : [],
                            refinedQuery: data?.refinedQuery || null,
                        },
                    },
                }
                : m
        ));
    },

    swarm_completed(ctx, data, ids) {
        const { setMessages } = ctx;
        const { assistantMsgId } = ids;
        setMessages(prev => prev.map(m =>
            m.id === assistantMsgId
                ? {
                    ...m,
                    swarm: {
                        ...(m.swarm || {}),
                        state: data?.paused ? 'awaiting_clarification' : 'done',
                        durationMs: data?.durationMs || null,
                        error: data?.error || null,
                    },
                }
                : m
        ));
    },

    // Per-worker streaming events — researcher tokens flow into
    // their own card; the synthesiser sends ordinary `content` so
    // its tokens show up in the assistant message body directly.
    swarm_worker_started(ctx, data, ids) {
        const { setMessages } = ctx;
        const { assistantMsgId } = ids;
        const workerId = String(data.workerId);
        setMessages(prev => prev.map(m => {
            if (m.id !== assistantMsgId) return m;
            const workers = { ...(m.swarm?.workers || {}) };
            workers[workerId] = {
                workerId: data.workerId,
                role: data.role,
                name: data.name,
                tier: data.tier,
                modelId: data.modelId,
                status: 'running',
                content: '',
                tools: [],
                startedAt: Date.now(),
            };
            return { ...m, swarm: { ...(m.swarm || {}), workers } };
        }));
    },

    swarm_worker_content(ctx, data, ids) {
        const { setMessages } = ctx;
        const { assistantMsgId } = ids;
        const workerId = String(data.workerId);
        setMessages(prev => prev.map(m => {
            if (m.id !== assistantMsgId) return m;
            const workers = { ...(m.swarm?.workers || {}) };
            const w = workers[workerId];
            if (!w) return m;
            workers[workerId] = { ...w, content: (w.content || '') + (data.delta || '') };
            return { ...m, swarm: { ...(m.swarm || {}), workers } };
        }));
    },

    swarm_worker_tool(ctx, data, ids) {
        const { setMessages } = ctx;
        const { assistantMsgId } = ids;
        const workerId = String(data.workerId);
        setMessages(prev => prev.map(m => {
            if (m.id !== assistantMsgId) return m;
            const workers = { ...(m.swarm?.workers || {}) };
            const w = workers[workerId];
            if (!w) return m;
            const tools = Array.isArray(w.tools) ? [...w.tools] : [];
            if (data.status === 'start') {
                tools.push({ name: data.toolName, status: 'running', at: Date.now() });
            } else {
                const idx = [...tools].reverse().findIndex(t => t.name === data.toolName && t.status === 'running');
                if (idx >= 0) {
                    const realIdx = tools.length - 1 - idx;
                    tools[realIdx] = { ...tools[realIdx], status: data.status };
                }
            }
            workers[workerId] = { ...w, tools };
            return { ...m, swarm: { ...(m.swarm || {}), workers } };
        }));
    },

    swarm_worker_completed(ctx, data, ids) {
        const { setMessages } = ctx;
        const { assistantMsgId } = ids;
        const workerId = String(data.workerId);
        setMessages(prev => prev.map(m => {
            if (m.id !== assistantMsgId) return m;
            const workers = { ...(m.swarm?.workers || {}) };
            const w = workers[workerId];
            if (!w) return m;
            workers[workerId] = {
                ...w,
                status: data.status || 'done',
                durationMs: data.durationMs || null,
                error: data.error || null,
            };
            return { ...m, swarm: { ...(m.swarm || {}), workers } };
        }));
    },
};
