import { extractGammaPreview } from '../gammaPreview';
import type { SseHandlerMap } from '../handlerTypes';

/**
 * Tool calls on the reply: confirmation cards, the test-chat marker, tool
 * start/end (with the Gamma preview) and the live browser preview.
 */
export const toolHandlers: SseHandlerMap = {
    tool_confirm(ctx, data, ids) {
        const { setMessages } = ctx;
        const { activeIdRef } = ids;
        // A call the agent did NOT run because a human has to say yes (server:
        // toolRoundExecutor gate 2). Until A4 this event had no client at all: it
        // was only stored as `assistantMsg.pendingToolCalls` and read by no one,
        // so "the agent wanted something and is waiting for you" never showed.
        //
        // The key is `argsKey`: NAME PLUS ARGUMENTS, from the server. Matching on
        // `callId` would be wrong: that is new every round, so the same action
        // would get two cards. And a decision keyed on the TOOL name would approve
        // a second, different mail with the click on the first.
        if (data && data.argsKey) {
            setMessages(prev => prev.map(m => {
                if (m.id !== activeIdRef.current) return m;
                const list = Array.isArray(m.pendingToolCalls) ? [...m.pendingToolCalls] : [];
                const at = list.findIndex(c => c.argsKey === data.argsKey);
                const next = { ...(at >= 0 ? list[at] : {}), ...data, status: data.status || 'pending' };
                if (at >= 0) list[at] = next; else list.push(next);
                return { ...m, pendingToolCalls: list };
            }));
        }
    },

    test_chat(ctx, data, ids) {
        const { setMessages } = ctx;
        const { activeIdRef } = ids;
        // Which agent really ran this turn: the DRAFT (test chat) or what is
        // published. From the server, never derived from what the client sent:
        // a test chat that could not load the draft must not show up as "your
        // draft".
        setMessages(prev => prev.map(m => (
            m.id === activeIdRef.current ? { ...m, testChat: data } : m
        )));
    },

    tool_start(ctx, data, ids) {
        const { setMessages } = ctx;
        const { assistantMsgId } = ids;
        setMessages(prev => prev.map(m => {
            if (m.id === assistantMsgId) {
                const update = {
                    ...m,
                    toolCall: { name: data.name, status: 'running' },
                    toolHistory: [...(m.toolHistory || []), {
                        name: data.name,
                        args: data.args,
                        status: 'running',
                        startTime: Date.now()
                    }]
                };
                if (data.name === 'sequentialthinking' && data.args?.thought) {
                    const steps = [...(m.thinkingSteps || [])];
                    steps.push({
                        thought: data.args.thought,
                        thoughtNumber: data.args.thoughtNumber,
                        totalThoughts: data.args.totalThoughts,
                        isRevision: data.args.isRevision,
                        branchFromThought: data.args.branchFromThought,
                        branchId: data.args.branchId,
                        status: 'running',
                        worker: data.worker || null,
                        instanceId: data.instanceId || null
                    });
                    update.thinkingSteps = steps;
                }
                return update;
            }
            return m;
        }));
    },

    tool_end(ctx, data, ids) {
        const { setMessages, onGammaPreviewRef } = ctx;
        const { assistantMsgId } = ids;
        {
            const gammaPreview = extractGammaPreview(data.name, data.result);
            if (gammaPreview) onGammaPreviewRef.current?.(gammaPreview);
        }
        setMessages(prev => prev.map(m => {
            if (m.id === assistantMsgId) {
                const trs = m.toolResults || [];
                // Mark the matching running tool in toolHistory as done
                const updatedHistory = (m.toolHistory || []).map(t =>
                    t.name === data.name && t.status === 'running'
                        ? {
                            ...t,
                            status: 'done',
                            endTime: Date.now(),
                            resultPreview: typeof data.result === 'string'
                                ? data.result.slice(0, 120)
                                : JSON.stringify(data.result || '').slice(0, 120)
                        }
                        : t
                );
                const update = {
                    ...m,
                    toolResults: [...trs, { name: data.name, result: data.result }],
                    toolCall: null,
                    toolHistory: updatedHistory,
                };
                if (data.name === 'sequentialthinking' && (m.thinkingSteps?.length ?? 0) > 0) {
                    const steps = [...(m.thinkingSteps ?? [])];
                    const lastRunning = steps.findLastIndex(s => s.status === 'running');
                    if (lastRunning >= 0) steps[lastRunning] = { ...steps[lastRunning], status: 'done' };
                    update.thinkingSteps = steps;
                }
                return update;
            }
            return m;
        }));
    },

    // ── Live browser preview (browse_web) ──────────────────────
    // A single `browserPreview` object per message, decoupled from
    // msg.toolCall (which is last-write-wins across parallel tools).
    // The <BrowserLivePreview> renders whenever this object exists.
    browser_session_queued(ctx, data, ids) {
        const { setMessages } = ctx;
        const { assistantMsgId } = ids;
        setMessages(prev => prev.map(m =>
            m.id === assistantMsgId
                ? { ...m, browserPreview: { sessionId: data.sessionId, url: data.url, task: data.task, queued: true, queuePosition: data.queuePosition, frame: null, action: null, ended: false } }
                : m
        ));
    },

    browser_session_start(ctx, data, ids) {
        const { setMessages } = ctx;
        const { assistantMsgId } = ids;
        setMessages(prev => prev.map(m => {
            if (m.id !== assistantMsgId) return m;
            const prevPreview = m.browserPreview && m.browserPreview.sessionId === data.sessionId ? m.browserPreview : {};
            return { ...m, browserPreview: { ...prevPreview, sessionId: data.sessionId, url: data.url, task: data.task, queued: false, queuePosition: null, frame: prevPreview.frame || null, action: prevPreview.action || null, ended: false } };
        }));
    },

    browser_frame(ctx, data, ids) {
        const { setMessages } = ctx;
        const { assistantMsgId } = ids;
        // Latest frame only — no accumulation, matches Tests Studio's
        // useTestRunEvents discipline for bounded memory.
        setMessages(prev => prev.map(m =>
            (m.id === assistantMsgId && m.browserPreview?.sessionId === data.sessionId)
                ? { ...m, browserPreview: { ...m.browserPreview, frame: data.b64 } }
                : m
        ));
    },

    browser_action(ctx, data, ids) {
        const { setMessages } = ctx;
        const { assistantMsgId } = ids;
        setMessages(prev => prev.map(m =>
            (m.id === assistantMsgId && m.browserPreview?.sessionId === data.sessionId)
                ? { ...m, browserPreview: { ...m.browserPreview, action: data.summary || data.tool || null } }
                : m
        ));
    },

    browser_session_end(ctx, data, ids) {
        const { setMessages } = ctx;
        const { assistantMsgId } = ids;
        setMessages(prev => prev.map(m =>
            (m.id === assistantMsgId && m.browserPreview?.sessionId === data.sessionId)
                ? { ...m, browserPreview: { ...m.browserPreview, ended: true } }
                : m
        ));
    },
};
