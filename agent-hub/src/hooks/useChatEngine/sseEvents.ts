import { appendPhase } from './phaseTrail';
import type { ChatMessage, SseDispatchContext, SseDispatchIds, SseEventData, ThinkingPart } from './types';
import { completedTools, summarizeWorkItem } from './workSummary';
import { logger } from '../../utils/logger';

/** What a gamma_* tool answered, once it is worth previewing. */
interface GammaPreview {
    generationId: string | null;
    status: string;
    gammaId: string | null;
    gammaUrl: string | null;
    exportUrl: string | null;
    templateGammaId: string | null;
    templateUrl: string | null;
    sourceTool: string;
}

/** What a gamma_* tool answers with, as far as the preview cares. */
interface GammaToolResult {
    error?: unknown;
    generationId?: string;
    status?: string;
    gammaId?: string;
    gammaUrl?: string;
    exportUrl?: string;
    templateGammaId?: string;
    templateUrl?: string;
}

const extractGammaPreview = (toolName: string | undefined, result: unknown): GammaPreview | null => {
    if (!toolName?.startsWith?.('gamma_')) return null;
    let raw: unknown = result;
    if (typeof raw === 'string') {
        try { raw = JSON.parse(raw); } catch { return null; }
    }
    if (!raw || typeof raw !== 'object') return null;
    const parsed = raw as GammaToolResult;
    if (parsed.error) return null;
    if (!parsed.generationId && !parsed.gammaUrl) return null;
    return {
        generationId: parsed.generationId || null,
        status: parsed.status || (parsed.gammaUrl ? 'completed' : 'pending'),
        gammaId: parsed.gammaId || null,
        gammaUrl: parsed.gammaUrl || null,
        exportUrl: parsed.exportUrl || null,
        templateGammaId: parsed.templateGammaId || null,
        templateUrl: parsed.templateUrl || null,
        sourceTool: toolName,
    };
};

/**
 * Dispatches one parsed SSE event from the chat stream onto React state and
 * the page-level callbacks. Extracted verbatim from useChatEngine's
 * `handleSSEEvent` useCallback — the hook wraps this in a useCallback and
 * threads its own state setters/refs via `ctx`, so behaviour (including which
 * values are captured at memoization time) is unchanged.
 *
 */
export function dispatchSSEEvent(
    ctx: SseDispatchContext,
    event: string,
    data: SseEventData,
    ids: SseDispatchIds,
): void {
    const {
        setMessages,
        onConversationCreated,
        onNotebookUpdate,
        onSessionSkillsChanged,
        tRef,
        onGammaPreviewRef,
        onNotebookDocUpdateRef,
        onNotebookSourceAddedRef,
        onHistoryLockedRef,
        onNotebookThemeUpdateRef,
        onWebpageDocUpdateRef,
        onWebpageSourceAddedRef,
        onWebpageExtraUpdateRef,
        onWebpageExtraDeletedRef,
    } = ctx;
    const { assistantMsgId, userMsgId, activeIdRef, contentRef, flusher, workRef } = ids;

    // DEBUG: log non-content events to help debug LinkedIn draft issue
    if (event !== 'content' && event !== 'thinking' && event !== 'ping') {
        logger.debug('[SSE Event]', event, data);
    }

    switch (event) {
        case 'ping':
            // SSE keepalive heartbeat (see server startSseHeartbeat). No-op —
            // its only job is to keep the connection warm through proxies so a
            // long, silent tool loop isn't idle-timed-out.
            break;

        case 'content':
            if (data.text) {
                // Append synchronously to the ref (always current), but defer
                // the React state commit to the next animation frame so a fast
                // token stream re-renders at ~60fps instead of per-token. The
                // flush settles the pre-LLM phase indicator and carries the
                // last-seen responder name/avatar — see createContentFlusher.
                contentRef.current += data.text;
                flusher.schedule(data.respondingAgentName, data.respondingAgentAvatar);
            }
            break;

        case 'phase':
            // Pre-LLM progress signal from any chat runtime. We render a
            // single rotating status line above the typing dots so users
            // see what is happening (KB search, attachment OCR, etc.)
            // instead of a silent stall before the first token.
            logger.debug('[phase]', data.stage, data.status, data.detail || '', '→ msgId', activeIdRef.current);
            setMessages(prev => {
                let updated = false;
                const next = prev.map(m => {
                    if (m.id !== activeIdRef.current) return m;
                    // Het blijvende SPOOR (A4 deel C), naast de live regel
                    // hieronder. Die regel is met opzet vluchtig — elke fase
                    // overschrijft de vorige en de eerste letter van het
                    // antwoord wist hem — dus was er ná afloop nergens te zien
                    // wat er gebeurd was. Dit is dezelfde stroom, opgeteld.
                    //
                    // Het spoor krijgt ook de `end` die de regel hieronder
                    // laat vallen: fases schuiven over elkaar heen (guardrails
                    // sluit ná privacy_scan), en dan is `currentPhase` allang
                    // een andere. Voor de live regel is dat juist; voor het
                    // spoor zou het de duur van een stap laten verdwijnen.
                    const phaseTrail = appendPhase(m.phaseTrail, data);
                    if (data.status === 'end' && m.currentPhase?.stage !== data.stage) {
                        return phaseTrail === m.phaseTrail ? m : { ...m, phaseTrail };
                    }
                    const phase = (data.status === 'end' || data.stage === 'streaming_start')
                        ? null
                        : { stage: data.stage, detail: data.detail || null, startedAt: Date.now() };
                    updated = true;
                    return { ...m, currentPhase: phase, phaseTrail };
                });
                if (!updated) console.warn('[phase] no message matched activeIdRef', activeIdRef.current, 'msgIds=', prev.map(p => p.id));
                return next;
            });
            break;

        case 'thinking_start': {
            const partId = data.partId;
            if (partId) {
                setMessages(prev => prev.map(m => {
                    if (m.id !== activeIdRef.current) return m;
                    const parts = Array.isArray(m.thinkingParts) ? [...m.thinkingParts] : [];
                    if (parts.find(p => p.id === partId)) return m;
                    parts.push({
                        id: partId,
                        text: '',
                        startedAt: Date.now(),
                        endedAt: null,
                        redacted: data.redacted || false,
                    });
                    return { ...m, thinkingParts: parts, thinkingStartedAt: m.thinkingStartedAt || Date.now() };
                }));
            }
            break;
        }

        case 'thinking':
            if (data.text) {
                setMessages(prev => prev.map(m => {
                    if (m.id !== activeIdRef.current) return m;
                    const prevParts = Array.isArray(m.thinkingParts) ? m.thinkingParts : [];
                    const parts = prevParts.map(p => ({ ...p })); // deep-clone each part so we can safely mutate
                    let idx = data.partId ? parts.findIndex(p => p.id === data.partId) : -1;
                    if (idx === -1) {
                        const lastIdx = parts.length - 1;
                        if (!data.partId && lastIdx >= 0 && !parts[lastIdx].endedAt) {
                            idx = lastIdx;
                        } else {
                            parts.push({
                                id: data.partId || `auto-${parts.length}`,
                                text: '',
                                startedAt: Date.now(),
                                endedAt: null,
                            });
                            idx = parts.length - 1;
                        }
                    }
                    parts[idx] = { ...parts[idx], text: parts[idx].text + data.text };
                    return {
                        ...m,
                        thinkingParts: parts,
                        thinking: (m.thinking || '') + data.text,
                        thinkingStartedAt: m.thinkingStartedAt || Date.now(),
                    };
                }));
            }
            break;

        case 'thinking_stop':
            if (data.partId) {
                setMessages(prev => prev.map(m => {
                    if (m.id !== activeIdRef.current) return m;
                    const prevParts = Array.isArray(m.thinkingParts) ? m.thinkingParts : [];
                    const parts = prevParts.map(p =>
                        p.id === data.partId
                            ? { ...p, endedAt: Date.now(), redacted: p.redacted || !!data.redacted }
                            : p
                    );
                    return { ...m, thinkingParts: parts, thinkingEndedAt: Date.now() };
                }));
            }
            break;

        case 'content_replace':
            // Allow empty string to clear content (e.g. clearing intermediate tool-call planning text)
            if (data.text !== undefined) {
                // Drop any pending append flush — the replace is authoritative
                // and must not be clobbered by a late frame carrying old text.
                flusher.cancel();
                contentRef.current = data.text;
                setMessages(prev => prev.map(m =>
                    m.id === assistantMsgId ? { ...m, content: data.text } : m
                ));
            }
            break;

        case 'content_redact': {
            const seconds = data.autoRedactSeconds || 5;
            setMessages(prev => prev.map(m =>
                m.id === userMsgId ? { ...m, isGuardrailViolation: true, deleteIn: seconds, willRedact: true } : m
            ));
            setTimeout(() => {
                setMessages(prev => prev.map(m =>
                    m.id === userMsgId ? { ...m, content: data.redactedMessage, isGuardrailViolation: false, isRedacted: true, willRedact: false } : m
                ));
            }, seconds * 1000);
            break;
        }

        // ── Swarm tier (Deep Research) ──────────────────────────────
        case 'swarm_started':
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
            break;
        case 'swarm_phase_started': {
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
            break;
        }
        case 'swarm_phase_completed': {
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
            break;
        }
        case 'swarm_clarification_required':
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
            break;
        case 'swarm_completed':
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
            break;
        // Per-worker streaming events — researcher tokens flow into
        // their own card; the synthesiser sends ordinary `content` so
        // its tokens show up in the assistant message body directly.
        case 'swarm_worker_started': {
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
            break;
        }
        case 'swarm_worker_content': {
            const workerId = String(data.workerId);
            setMessages(prev => prev.map(m => {
                if (m.id !== assistantMsgId) return m;
                const workers = { ...(m.swarm?.workers || {}) };
                const w = workers[workerId];
                if (!w) return m;
                workers[workerId] = { ...w, content: (w.content || '') + (data.delta || '') };
                return { ...m, swarm: { ...(m.swarm || {}), workers } };
            }));
            break;
        }
        case 'swarm_worker_tool': {
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
            break;
        }
        case 'swarm_worker_completed': {
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
            break;
        }

        case 'session_skills_bootstrap_started':
            // Tag the in-flight assistant message so MessageItem can show a
            // "Preparing chat-local skills…" status above the reply.
            setMessages(prev => prev.map(m =>
                m.id === assistantMsgId
                    ? { ...m, sessionSkillsBootstrap: { state: 'pending' } }
                    : m
            ));
            break;
        case 'session_skills_bootstrapped':
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
            break;
        case 'session_skills_updated':
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
            break;
        case 'session_skill_completed':
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
            break;

        case 'tool_confirm':
            // Een call die de agent NIET heeft gedraaid omdat er een mens ja
            // moet zeggen (server: toolRoundExecutor gate 2). Tot A4 had dit
            // event geen enkele client: het werd alleen als
            // `assistantMsg.pendingToolCalls` opgeslagen en door niemand
            // gelezen, dus "de agent wilde iets en wacht op jou" was op het
            // scherm niet te zien.
            //
            // Sleutel is `argsKey` — NAAM PLUS ARGUMENTEN, van de server. Op
            // `callId` matchen zou fout zijn: dat is elke ronde een nieuwe, dus
            // dezelfde actie zou twee kaarten krijgen. En een beslissing die
            // op de tóól-naam zou slaan zou een tweede, ándere mail goedkeuren
            // met de klik van de eerste.
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
            break;

        case 'test_chat':
            // Welke agent draaide deze beurt echt: het CONCEPT (testchat) of
            // wat er gepubliceerd staat. Van de server, nooit afgeleid uit wat
            // de client stuurde — een testchat die het concept niet kon laden
            // mag niet als "je concept" op het scherm komen.
            setMessages(prev => prev.map(m => (
                m.id === activeIdRef.current ? { ...m, testChat: data } : m
            )));
            break;

        case 'tool_start':
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
            break;

        case 'tool_end':
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
            break;

        // ── Live browser preview (browse_web) ──────────────────────
        // A single `browserPreview` object per message, decoupled from
        // msg.toolCall (which is last-write-wins across parallel tools).
        // The <BrowserLivePreview> renders whenever this object exists.
        case 'browser_session_queued':
            setMessages(prev => prev.map(m =>
                m.id === assistantMsgId
                    ? { ...m, browserPreview: { sessionId: data.sessionId, url: data.url, task: data.task, queued: true, queuePosition: data.queuePosition, frame: null, action: null, ended: false } }
                    : m
            ));
            break;

        case 'browser_session_start':
            setMessages(prev => prev.map(m => {
                if (m.id !== assistantMsgId) return m;
                const prevPreview = m.browserPreview && m.browserPreview.sessionId === data.sessionId ? m.browserPreview : {};
                return { ...m, browserPreview: { ...prevPreview, sessionId: data.sessionId, url: data.url, task: data.task, queued: false, queuePosition: null, frame: prevPreview.frame || null, action: prevPreview.action || null, ended: false } };
            }));
            break;

        case 'browser_frame':
            // Latest frame only — no accumulation, matches Tests Studio's
            // useTestRunEvents discipline for bounded memory.
            setMessages(prev => prev.map(m =>
                (m.id === assistantMsgId && m.browserPreview?.sessionId === data.sessionId)
                    ? { ...m, browserPreview: { ...m.browserPreview, frame: data.b64 } }
                    : m
            ));
            break;

        case 'browser_action':
            setMessages(prev => prev.map(m =>
                (m.id === assistantMsgId && m.browserPreview?.sessionId === data.sessionId)
                    ? { ...m, browserPreview: { ...m.browserPreview, action: data.summary || data.tool || null } }
                    : m
            ));
            break;

        case 'browser_session_end':
            setMessages(prev => prev.map(m =>
                (m.id === assistantMsgId && m.browserPreview?.sessionId === data.sessionId)
                    ? { ...m, browserPreview: { ...m.browserPreview, ended: true } }
                    : m
            ));
            break;

        case 'model_selected':
            // Server emits this on every turn now. `fromAuto` tells us
            // whether the user was on Auto (so we render "Auto → Fast")
            // versus a pinned tier (where we just show the model name).
            setMessages(prev => prev.map(m =>
                m.id === activeIdRef.current ? {
                    ...m,
                    modelId: data.modelId || m.modelId,
                    modelTier: data.tier || m.modelTier,
                    autoSelectedTier: data.fromAuto ? data.tier : m.autoSelectedTier,
                } : m
            ));
            break;

        case 'document_truncated':
            // The notebook document was too long for the system prompt — server
            // trimmed it to fit. Store the counts on the streaming message so
            // the UI can show a one-time banner ("Document too large — only
            // N of M tokens shown"). Client decides how to render; we just
            // attach the data.
            setMessages(prev => prev.map(m =>
                m.id === activeIdRef.current ? {
                    ...m,
                    documentTruncation: {
                        originalTokens: data.originalTokens,
                        keptTokens: data.keptTokens,
                    },
                } : m
            ));
            break;

        case 'email_draft': {
            const draftKey = JSON.stringify({ to: data.to, subject: data.subject, body: data.body });
            setMessages(prev => prev.map(m => {
                if (m.id !== assistantMsgId) return m;
                const existing = m.emailDrafts || [];
                if (existing.some(d => JSON.stringify({ to: d.to, subject: d.subject, body: d.body }) === draftKey)) return m;
                return { ...m, emailDrafts: [...existing, { ...data, status: 'pending' }] };
            }));
            break;
        }

        case 'linkedin_draft':
            logger.debug('[DEBUG] linkedin_draft event received!', data, 'assistantMsgId:', assistantMsgId);
            setMessages(prev => {
                const updated = prev.map(m =>
                    m.id === assistantMsgId ? {
                        ...m,
                        linkedInDrafts: [...(m.linkedInDrafts || []), { ...data, status: 'pending' }]
                    } : m
                );
                logger.debug('[DEBUG] Messages after linkedin_draft update:', updated.map(m => ({ id: m.id, hasLinkedInDrafts: !!m.linkedInDrafts, linkedInDraftsCount: m.linkedInDrafts?.length })));
                return updated;
            });
            break;

        case 'calendar_draft': {
            // Key on the real draft fields (action/title/startTime/endTime/
            // eventId); summary/start/end are never present so the old key
            // deduped nothing and duplicate cards stacked up (BFSF-123).
            const calKey = (d: SseEventData | Record<string, unknown> | undefined) => JSON.stringify({ action: d?.action, title: d?.title, startTime: d?.startTime, endTime: d?.endTime, eventId: d?.eventId });
            const draftKey = calKey(data);
            setMessages(prev => prev.map(m => {
                if (m.id !== assistantMsgId) return m;
                const existing = m.calendarDrafts || [];
                if (existing.some(d => calKey(d) === draftKey)) return m;
                return { ...m, calendarDrafts: [...existing, { ...data, status: 'pending' }] };
            }));
            break;
        }

        case 'contacts_draft': {
            const draftKey = JSON.stringify({ name: data.name, email: data.email, phone: data.phone });
            setMessages(prev => prev.map(m => {
                if (m.id !== assistantMsgId) return m;
                const existing = m.contactsDrafts || [];
                if (existing.some(d => JSON.stringify({ name: d.name, email: d.email, phone: d.phone }) === draftKey)) return m;
                return { ...m, contactsDrafts: [...existing, { ...data, status: 'pending' }] };
            }));
            break;
        }

        case 'keep_draft': {
            const draftKey = JSON.stringify({ title: data.title, content: data.content });
            setMessages(prev => prev.map(m => {
                if (m.id !== assistantMsgId) return m;
                const existing = m.keepDrafts || [];
                if (existing.some(d => JSON.stringify({ title: d.title, content: d.content }) === draftKey)) return m;
                return { ...m, keepDrafts: [...existing, { ...data, status: 'pending' }] };
            }));
            break;
        }




        case 'map_embed':
            setMessages(prev => prev.map(m =>
                m.id === assistantMsgId ? {
                    ...m,
                    mapEmbeds: [...(m.mapEmbeds || []), data]
                } : m
            ));
            break;

        case 'image':
            if (data.data && data.mimeType) {
                setMessages(prev => prev.map(m =>
                    m.id === activeIdRef.current ? {
                        ...m,
                        images: [...(m.images || []), {
                            data: data.data,
                            mimeType: data.mimeType,
                        }]
                    } : m
                ));
            }
            break;

        case 'audio':
            if (data.url) {
                setMessages(prev => prev.map(m =>
                    m.id === activeIdRef.current ? {
                        ...m,
                        audioFiles: [...(m.audioFiles || []), {
                            url: data.url,
                            mimeType: data.mimeType || 'audio/mpeg',
                            source: data.source || 'elevenlabs',
                        }]
                    } : m
                ));
            }
            break;

        case 'file':
            // A file a tool built (a deck): the card under the reply — shown
            // whether or not the model remembers to write the link.
            if (data && (data.url || data.webUrl)) {
                setMessages(prev => prev.map(m =>
                    m.id === activeIdRef.current ? { ...m, files: [...(m.files || []), data] } : m
                ));
            }
            break;

        case 'video':
            if (data.url && data.mimeType) {
                setMessages(prev => prev.map(m =>
                    m.id === activeIdRef.current ? {
                        ...m,
                        videoFiles: [...(m.videoFiles || []), {
                            url: data.url,
                            mimeType: data.mimeType,
                        }]
                    } : m
                ));
            }
            break;

        case 'kb_sources':
            if (data.sources) {
                const sources = data.sources;
                setMessages(prev => prev.map(m => {
                    if (m.id !== assistantMsgId) return m;
                    // Merge with existing sources, deduplicate by content (not title — allows multiple chunks from same doc)
                    const existing = m.kbSources || [];
                    const existingContentKeys = new Set(existing.map(s => (s.content || '').slice(0, 100)));
                    const newSources = sources.filter(s => !existingContentKeys.has((s.content || '').slice(0, 100)));
                    return { ...m, kbSources: [...existing, ...newSources] };
                }));
            }
            break;

        // The memories this turn drew on. Sent once, only when non-empty.
        case 'memory_used':
            if (Array.isArray(data?.items) && data.items.length > 0) {
                const items = data.items;
                setMessages(prev => prev.map(m => (
                    m.id === assistantMsgId ? { ...m, memoryUsed: items } : m
                )));
            }
            break;

        // De attributie-pass van een TESTCHAT (A4): welke `doesNot`-regels van
        // de rol dit antwoord zichtbaar volgde. Een MENING, geen notulen — de
        // chiprij toont hem daarom apart (zie AnswerChips.jsx).
        //
        // Alleen een niet-lege lijst landt. Een leeg of onleesbaar payload zou
        // anders een eerdere uitspraak wissen, en "er staat nu niets" zou als
        // "er is niets gevolgd" gelezen kunnen worden — precies de bewering die
        // de pass niet mag doen.
        case 'rule_attribution':
            if (Array.isArray(data?.rules) && data.rules.length > 0) {
                setMessages(prev => prev.map(m => (
                    m.id === assistantMsgId
                        ? { ...m, ruleAttribution: { rules: data.rules } }
                        : m
                )));
            }
            break;

        case 'workspace_update':
            onNotebookUpdate?.(data.content);
            break;

        case 'notebook_doc_update':
            // `version` rides along so the page can resync its CAS counter
            // (AI doc writes bump the notebook version server-side).
            onNotebookDocUpdateRef.current?.(data.content, data.title, data.version);
            break;

        // Slides-specific aliases (same callbacks as notebook)
        case 'slides_deck_update':
            onNotebookDocUpdateRef.current?.(data.slides, data.title);
            break;

        case 'slides_theme_update':
            onNotebookThemeUpdateRef.current?.(data.theme);
            break;

        case 'notebook_source_added':
            onNotebookSourceAddedRef.current?.(data.source);
            break;

        // The store refused to persist this turn over an encrypted history
        // it cannot open (locked). Page locks the composer in response.
        case 'history_locked':
            onHistoryLockedRef.current?.(data);
            break;

        // Webpage-specific events (file: 'html'|'css'|'js', content: string)
        case 'webpage_doc_update':
            onWebpageDocUpdateRef.current?.({ file: data.file, content: data.content, title: data.title });
            break;

        case 'webpage_source_added':
            onWebpageSourceAddedRef.current?.(data.source);
            break;

        // Multi-file events: extra-file create/update or delete.
        case 'webpage_extra_update':
            onWebpageExtraUpdateRef.current?.({ path: data.path, meta: data.meta });
            break;

        case 'webpage_extra_deleted':
            onWebpageExtraDeletedRef.current?.({ path: data.path });
            break;

        // The AI created or rewrote a Document. Re-broadcast as a DOM event
        // (the webpage_db_update idiom below) so an open Documents list or
        // editor refreshes itself, without drilling a callback through the
        // chat → Studio → editor prop chain.
        case 'document_update':
            try {
                window.dispatchEvent(new CustomEvent('beeflow:document-updated', {
                    detail: { documentId: data.documentId, name: data.name, url: data.url },
                }));
            } catch (_) {}
            break;

        // The AI proposed changes to a page instead of writing them: tell the
        // open editor's suggestions list (api/queries/suggestions.ts).
        case 'document_suggestions':
            try {
                window.dispatchEvent(new CustomEvent('beeflow:document-suggestions', {
                    detail: { documentId: data.documentId, batchId: data.batchId, count: data.count },
                }));
            } catch (_) {}
            break;

        // DB tool wrote — re-broadcast as a DOM event so the open DB
        // viewer (if mounted) can refresh its schema/rows. Avoids drilling
        // a callback through the chat → IDE → viewer prop chain.
        case 'webpage_db_update':
            try { window.dispatchEvent(new CustomEvent('webpage_db_update')); } catch (_) {}
            break;

        // The AI switched this project's framework / runtime tier. Re-broadcast
        // as a DOM event so the page can update settings + recompose the
        // preview without drilling a callback through the prop chain.
        case 'webpage_framework_changed':
            try { window.dispatchEvent(new CustomEvent('webpage_framework_changed', { detail: { framework: data.framework } })); } catch (_) {}
            break;
        case 'webpage_runtime_changed':
            try { window.dispatchEvent(new CustomEvent('webpage_runtime_changed', { detail: { runtime: data.runtime } })); } catch (_) {}
            break;

        // Webpage plan proposal — attach to the in-flight assistant message
        // so the chat can render an approval card. The user will click
        // Approve/Reject and the plan card flips status; on Approve a new
        // chat send is fired with planExecution: { planId, action: 'execute' }.
        case 'webpage_plan_proposed':
            if (data && data.planId && data.plan) {
                const planEntry = { planId: data.planId, plan: data.plan, status: 'pending' };
                setMessages(prev => {
                    if (!prev || prev.length === 0) return prev;
                    for (let i = prev.length - 1; i >= 0; i--) {
                        if (prev[i].role === 'assistant') {
                            return [
                                ...prev.slice(0, i),
                                { ...prev[i], webpagePlan: planEntry },
                                ...prev.slice(i + 1),
                            ];
                        }
                    }
                    return prev;
                });
            }
            break;

        case 'slides_source_added':
            onNotebookSourceAddedRef.current?.(data.source);
            break;

        // Sheet-specific aliases (same callbacks as notebook/slides)
        case 'sheet_update':
            onNotebookDocUpdateRef.current?.(data.cells, data.sheetIndex);
            break;

        case 'sheet_source_added':
            onNotebookSourceAddedRef.current?.(data.source);
            break;

        // Proposal-specific aliases
        case 'proposal_blocks_update':
            onNotebookDocUpdateRef.current?.(data.blocks);
            break;

        case 'done':
            // Commit any buffered tokens before finalizing — 'done' preserves
            // m.content, so a not-yet-flushed tail would otherwise be lost.
            flusher.flushNow();
            setMessages(prev => prev.map(m => {
                if (m.id === activeIdRef.current) {
                    const update = { ...m, isStreaming: false, toolCall: null };
                    if (m.thinkingSteps?.some(s => s.status === 'running')) {
                        update.thinkingSteps = m.thinkingSteps.map(s =>
                            s.status === 'running' ? { ...s, status: 'done' } : s
                        );
                    }

                    // Defense in depth: a well-formed 'done' can still carry an
                    // empty reply (a provider failure swallowed upstream). A blank
                    // bubble reads as "the conversation just stopped" — annotate it.
                    // Replies that produced work cards without prose stay untouched.
                    if ((!update.content || !update.content.trim()) && !m.workItem) {
                        update.content = '(The model returned an empty response — please try again.)';
                    }

                    return update;
                }
                return m;
            }));
            if (data.conversationId) {
                onConversationCreated?.(data.conversationId);
            }

            if (data.notebookspaceContent !== undefined) {
                onNotebookUpdate?.(data.notebookspaceContent);
            }
            break;

        case 'error': {
            // Commit any buffered tokens now, so the reply so far is complete
            // when it is kept below; flushNow also cancels the scheduled frame,
            // so no late append can overwrite the error message.
            flusher.flushNow();
            const errMsg = typeof data.error === 'string'
                ? data.error
                : (data.error?.message || JSON.stringify(data.error) || 'An error occurred');
            // If work was already produced before the error, lead with what
            // was created so the error doesn't read as "nothing happened"
            // and trigger a duplicate retry (BFSF-221).
            const summary = summarizeWorkItem(tRef.current, workRef?.current);
            setMessages(prev => prev.map(m => {
                if (m.id !== assistantMsgId) return m;
                const base = {
                    ...m,
                    isStreaming: false,
                    isError: true,
                    ...(summary ? { workItem: workRef.current } : {}),
                };
                // Tools that already finished in this turn (a ticket created,
                // a mail sent) HAPPENED, whatever failed after them. Keep the
                // reply so far, name those actions before the error, and flag
                // the message so it is not labelled "Failed to send": the
                // message was sent, and a retry would do the work twice
                // (BFSF-349). The tool rows stay on the message as they are.
                const done = completedTools(m);
                if (done.count === 0) {
                    return { ...base, content: summary ? summary + '\n\n' + errMsg : errMsg };
                }
                const prior = (m.content && m.content.trim()) ? m.content.trimEnd() + '\n\n' : '';
                const toolsLine = tRef.current('chat.work_summary.tools', { tools: done.labels.join(', ') });
                const lead = summary ? `${summary}\n\n${toolsLine}` : toolsLine;
                return {
                    ...base,
                    content: `${prior}${lead}\n\n${errMsg}`,
                    errorDetail: errMsg,
                    completedToolCount: done.count,
                };
            }));
            break;
        }

        case 'dlp_preview': {
            // Server is pausing the stream until the user responds via
            // the DLP decision endpoint. The modal listens for this event.
            window.dispatchEvent(new CustomEvent('beeflow:dlp_preview', { detail: data }));
            break;
        }
        case 'dlp_attachment_preview': {
            // Same pause, for a file attachment instead of the typed message —
            // one event per attachment that needs review (see
            // attachmentAskFlow.js: sequential, not batched). The modal
            // renders it in a document-shaped card instead of a chat bubble.
            window.dispatchEvent(new CustomEvent('beeflow:dlp_attachment_preview', { detail: data }));
            break;
        }
        case 'dlp_resolved': {
            window.dispatchEvent(new CustomEvent('beeflow:dlp_resolved', { detail: data }));
            if (data?.appliedChoice === 'redact' && (data?.redactedCount ?? 0) > 0) {
                const info = {
                    source: 'dlp',
                    action: data.appliedChoice,
                    count: data.redactedCount,
                    categories: data.categories || [],
                    provider: (typeof data.provider === 'object' ? data.provider?.displayName : undefined) || null,
                    automatic: !!data.automatic,
                };
                setMessages(prev => prev.map(m => {
                    if (m.id === userMsgId) {
                        return { ...m, dlpRedactedCount: data.redactedCount, dlpCategories: data.categories || [] };
                    }
                    // Also stash the info on the assistant message so the
                    // "How I got this answer" panel can render the privacy step.
                    if (m.id === assistantMsgId) {
                        return { ...m, tokenisationInfo: info };
                    }
                    return m;
                }));
            }
            break;
        }
        case 'pii_tokenized': {
            const entities = Array.isArray(data?.entities) ? data.entities : [];
            const categories = [...new Set(entities.map(e => e.label || e.category).filter(Boolean))];
            const count = data?.tokenCount || entities.length;
            const attachments = Array.isArray(data?.attachments) ? data.attachments : null;
            // `pii_tokenized` now fires for both message-level PII and
            // attachment-level (Privacy Shield) detections. Merge with
            // any prior tokenisationInfo rather than replacing it — the
            // two paths can both fire on the same turn (user text + PDF).
            // Lightweight "scan incomplete" warnings (large upload passed
            // through unredacted under fail_open) — surfaced as an amber pill
            // under the USER message. Only rows that were NOT fully tokenised.
            const scanWarnings = (attachments || [])
                .filter(a => a && (a.reason || a.timeout || a.overflow) && a.action !== 'tokenize')
                .map(a => ({
                    filename: a.filename,
                    reason: a.reason || (a.timeout ? 'timeout' : (a.overflow ? 'overflow' : 'degraded')),
                    scannedPages: a.scannedPages,
                    totalPages: a.totalPages,
                }));
            setMessages(prev => prev.map(m => {
                if (m.id === userMsgId) {
                    return {
                        ...m,
                        piiTokenizedCount: (m.piiTokenizedCount || 0) + count,
                        piiCategories: [...new Set([...(m.piiCategories || []), ...categories])],
                        piiScanWarnings: [...(m.piiScanWarnings || []), ...scanWarnings],
                    };
                }
                if (m.id === assistantMsgId) {
                    const prevInfo = m.tokenisationInfo || null;
                    const mergedCats = [...new Set([...(prevInfo?.categories || []), ...categories])];
                    const mergedCount = (prevInfo?.count || 0) + count;
                    const info = {
                        source: data?.source || prevInfo?.source || 'pii',
                        action: prevInfo?.action || 'redact',
                        count: mergedCount,
                        categories: mergedCats,
                        provider: prevInfo?.provider || null,
                        automatic: prevInfo ? !!prevInfo.automatic : true,
                        // Attachments list (per-file detail) — only set when this
                        // event carries it. Existing per-file entries are
                        // preserved so a second event doesn't blow them away.
                        attachments: attachments
                            ? [...(prevInfo?.attachments || []), ...attachments]
                            : (prevInfo?.attachments || undefined),
                        tokenMap: prevInfo?.tokenMap || undefined,
                        tokenizedPrompt: prevInfo?.tokenizedPrompt || undefined,
                        rawResponse: prevInfo?.rawResponse || undefined,
                        rawTruncated: prevInfo?.rawTruncated,
                    };
                    return { ...m, tokenisationInfo: info };
                }
                return m;
            }));
            break;
        }
        case 'privacy_payload': {
            // Transparency: the exact tokenised string that was sent to the LLM.
            // Gated server-side by org `showRawPayload`. Attach to the assistant
            // message so "How I got this answer → Privacy protection" can render it.
            setMessages(prev => prev.map(m => m.id === assistantMsgId
                ? { ...m, tokenisationInfo: { ...(m.tokenisationInfo || {}), tokenizedPrompt: data?.tokenizedPrompt || '', provider: data?.provider || m.tokenisationInfo?.provider || null } }
                : m));
            break;
        }
        case 'privacy_response_raw': {
            // The raw pre-un-tokenise LLM response. Same gating as privacy_payload.
            setMessages(prev => prev.map(m => m.id === assistantMsgId
                ? { ...m, tokenisationInfo: { ...(m.tokenisationInfo || {}), rawResponse: data?.rawResponse || '', rawTruncated: !!data?.truncated } }
                : m));
            break;
        }
        case 'privacy_token_map': {
            // Explicit { token: realValue } mapping. Server-gated by org `showRawPayload`.
            // Lets the privacy panel render an exact "[name_1] → Gerard" table.
            const incoming = data?.tokenMap || {};
            if (Object.keys(incoming).length === 0) break;
            setMessages(prev => prev.map(m => m.id === assistantMsgId
                ? { ...m, tokenisationInfo: { ...(m.tokenisationInfo || {}), tokenMap: { ...(m.tokenisationInfo?.tokenMap || {}), ...incoming } } }
                : m));
            break;
        }
        case 'tokenisation_info': {
            // Server-synthesised tokenisation info for actions that don't
            // fire `dlp_resolved` (restore: AI echoed tokens this turn;
            // protected: conv vault non-empty even when no token activity
            // this turn). Carries count/action/categories/tokenMap so the
            // pill and Privacy panel render live, not only after refresh.
            if (!data || typeof data !== 'object') break;
            setMessages(prev => prev.map(m => m.id === assistantMsgId
                ? { ...m, tokenisationInfo: { ...(m.tokenisationInfo || {}), ...data, tokenMap: { ...(m.tokenisationInfo?.tokenMap || {}), ...(data.tokenMap || {}) } } }
                : m));
            break;
        }
        case 'dlp_blocked': {
            window.dispatchEvent(new CustomEvent('beeflow:dlp_blocked', { detail: data }));
            // Drop any pending append so a buffered token can't overwrite
            // the block notice composed below.
            flusher.cancel();
            const reason = data?.reason || 'policy';
            let msg;
            // Elke bijlage-tak draagt de bestandsnaam als PARAMETER, niet als
            // stuk string in de code: de woordenboekwaarde wint van de
            // fallback (useTranslation.jsx), dus een zin die met `${file}` is
            // opgebouwd kwam nooit op het scherm — de gebruiker las letterlijk
            // `{filename}`. Grammatica (wel/geen bestandsnaam) zit om de
            // SLEUTEL, niet om een uitgang.
            const fileName = () => data?.filename || tRef.current('dlp.the_attachment', 'the attachment');
            if (reason === 'attachment_pii') {
                const cats = Array.isArray(data?.categories) && data.categories.length
                    ? data.categories.join(', ')
                    : tRef.current('dlp.categories_unknown', 'PII');
                const params = { categories: cats, filename: data?.filename };
                msg = data?.filename
                    ? tRef.current('dlp.blocked_attachment_pii',
                        'Attachment blocked: sensitive data ({categories}) was detected in “{filename}”. Please remove the PII and re-upload.',
                        params)
                    : tRef.current('dlp.blocked_attachment_pii_nofile',
                        'Attachment blocked: sensitive data ({categories}) was detected. Please remove the PII and re-upload.',
                        params);
            } else if (reason === 'attachment_overflow') {
                msg = tRef.current('dlp.blocked_attachment_overflow',
                    'Attachment held: {filename} is too large to fully scan for sensitive data. Split it or reduce the page count, then re-upload.',
                    { filename: fileName() });
            } else if (reason === 'attachment_timeout') {
                msg = tRef.current('dlp.blocked_attachment_timeout',
                    "Attachment held: scanning {filename} for sensitive data didn't finish in time. Please try again or split the document.",
                    { filename: fileName() });
            } else if (reason === 'attachment_degraded') {
                msg = tRef.current('dlp.blocked_attachment_degraded',
                    'Attachment held: sensitive-data scanning for {filename} is temporarily unavailable. Please try again shortly.',
                    { filename: fileName() });
            } else if (reason === 'attachment_user_blocked') {
                msg = tRef.current('dlp.blocked_attachment_user',
                    '{filename} was not sent — you chose to block it during the review.',
                    { filename: fileName() });
            } else if (reason === 'attachment_ask_timeout') {
                msg = tRef.current('dlp.blocked_attachment_ask_timeout',
                    '{filename} was not sent — the privacy review timed out before you responded. Please try again.',
                    { filename: fileName() });
            } else if (reason === 'pii_unavailable' && data?.kind === 'too_large') {
                // Same block, different truth. "Try again in a moment" is
                // actively misleading here: the retry scans the same text and
                // fails identically. Splitting the message is the only thing
                // that works, so say that instead.
                msg = tRef.current('dlp.blocked_pii_too_large',
                    'This message is too large to scan for personal data, so it was not sent. Please split it into smaller parts.');
            } else if (reason === 'pii_unavailable') {
                // Fail-closed: PII detection was degraded (guard down / model
                // not ready), so the message was NOT sent unmasked (BFSF-269).
                msg = tRef.current('dlp.blocked_pii_unavailable',
                    'Privacy protection is temporarily unavailable, so your message was not sent. Please try again in a moment.');
            } else {
                const labelKey = reason === 'timeout' ? 'dlp.blocked_timeout'
                    : reason === 'user_blocked' ? 'dlp.blocked_user'
                    : 'dlp.blocked_policy';
                msg = tRef.current(labelKey, {
                    timeout: 'Blocked: DLP decision timed out.',
                    user_blocked: 'Prompt blocked by you.',
                    policy: 'Prompt blocked by data-loss-prevention policy.',
                }[reason] || 'Prompt blocked by DLP.');
            }
            setMessages(prev => prev.map(m =>
                m.id === assistantMsgId ? { ...m, content: msg, isStreaming: false, isError: true } : m
            ));
            break;
        }

        case 'guardrail_violation': {
            const secs = data.autoDeleteSeconds || 5;
            const categories = data.categories || data.rules || [];
            const categoryText = Array.isArray(categories) ? categories.join(', ') : '';
            setMessages(prev => prev.map(m =>
                m.id === userMsgId ? { ...m, isGuardrailViolation: true, deleteIn: secs, violationCategories: categoryText } : m
            ));
            setTimeout(() => {
                setMessages(prev => prev.map(m =>
                    m.id === userMsgId ? { ...m, content: '[Message removed - policy violation]', isGuardrailViolation: false, isDeleted: true } : m
                ));
            }, secs * 1000);
            break;
        }

        case 'guardrail_blocked': {
            // Drop any pending append — the canned response is authoritative.
            flusher.cancel();
            // Compose translated canned response using i18n keys
            const title = tRef.current('chat.guardrail_blocked_title', { violation: data.violation || 'Policy Violation' });
            const body = tRef.current('chat.guardrail_blocked_body');
            const translatedResponse = `${title}\n\n${body}`;
            contentRef.current = translatedResponse;
            setMessages(prev => prev.map(m =>
                m.id === activeIdRef.current ? { ...m, content: translatedResponse } : m
            ));
            break;
        }


    }
}
