import { useCallback, useRef, useState } from 'react';
import { API_BASE, authFetch } from '../utils/helpers';

/**
 * SSE hook for the standalone "build / refine a layer with AI" agent
 * (POST /api/automation/builder/layer-agent) — SEPARATE from the chat
 * builder stream. Drives the Layers panel's instruction box: the user
 * describes a layer, a thinking-model sub-agent builds it, and on completion
 * `send` resolves with the updated definition for the caller to apply.
 *
 * Events handled: builder_session, layer_agent_start, tool_call,
 * layer_agent_done, draft, done, error.
 *
 *   const { state, send, cancel } = useFlowletAgentStream();
 *   const { draft, layerKey, error } = await send({ automationId, instruction, mode });
 *   if (draft) applyDefinition(draft);
 */

/** One tool the sub-agent ran while building the layer. */
export interface LayerToolCall {
    layerKey?: string;
    name?: string;
    arguments?: unknown;
    result?: unknown;
}

/** An automation definition, applied by the caller — never read here. */
export type AutomationDraft = Record<string, unknown>;

export type FlowletAgentMode = 'create' | 'refine';

export interface FlowletAgentState {
    running: boolean;
    mode: FlowletAgentMode;
    /** Layer key currently being built or refined. */
    activeKey: string | null;
    toolCalls: LayerToolCall[];
    summary: string;
    outputFields: unknown[];
    draft: AutomationDraft | null;
    error: string | null;
}

export interface FlowletAgentRequest {
    automationId: string;
    instruction: string;
    mode?: FlowletAgentMode;
    layerKey?: string | null;
    title?: string | null;
}

export interface FlowletAgentOutcome {
    draft: AutomationDraft | null;
    layerKey: string | null;
    error: string | null;
}

export interface UseFlowletAgentStreamReturn {
    state: FlowletAgentState;
    send: (req: FlowletAgentRequest) => Promise<FlowletAgentOutcome>;
    cancel: () => void;
    reset: () => void;
}

const EMPTY: FlowletAgentState = {
    running: false,
    mode: 'create',
    activeKey: null,
    toolCalls: [],
    summary: '',
    outputFields: [],
    draft: null,
    error: null,
};

export default function useFlowletAgentStream(): UseFlowletAgentStreamReturn {
    const [state, setState] = useState<FlowletAgentState>(EMPTY);
    const abortRef = useRef<AbortController | null>(null);

    const cancel = useCallback(() => {
        if (abortRef.current) { try { abortRef.current.abort(); } catch { /* already gone */ } }
        setState(s => ({ ...s, running: false }));
    }, []);

    const reset = useCallback(() => setState(EMPTY), []);

    const send = useCallback(async (
        { automationId, instruction, mode = 'create', layerKey = null, title = null }: FlowletAgentRequest,
    ): Promise<FlowletAgentOutcome> => {
        if (abortRef.current) { try { abortRef.current.abort(); } catch { /* already gone */ } }
        const ac = new AbortController();
        abortRef.current = ac;
        setState({ ...EMPTY, running: true, mode, activeKey: layerKey || null });

        let finalDraft: AutomationDraft | null = null;
        let finalKey: string | null = layerKey || null;
        let errMsg: string | null = null;
        try {
            const resp = await authFetch(`${API_BASE}/api/automation/builder/layer-agent`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ automationId, instruction, mode, layerKey, title }),
                signal: ac.signal,
            });
            if (!resp.ok || !resp.body) {
                errMsg = (await safeText(resp)) || `HTTP ${resp.status}`;
                setState(s => ({ ...s, running: false, error: errMsg }));
                return { draft: null, layerKey: finalKey, error: errMsg };
            }
            const reader = resp.body.getReader();
            const decoder = new TextDecoder();
            let buf = '';
            let ev = 'message';
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                buf += decoder.decode(value, { stream: true });
                const lines = buf.split('\n');
                buf = lines.pop() ?? '';
                for (const line of lines) {
                    if (line.startsWith('event: ')) { ev = line.slice(7).trim(); continue; }
                    if (!line.startsWith('data: ')) continue;
                    let data; try { data = JSON.parse(line.slice(6)); } catch { continue; }
                    switch (ev) {
                        case 'layer_agent_start':
                            setState(s => ({ ...s, activeKey: data.layerKey || s.activeKey }));
                            break;
                        case 'tool_call':
                            setState(s => ({ ...s, toolCalls: [...s.toolCalls, data] }));
                            break;
                        case 'layer_agent_done':
                            setState(s => ({ ...s, summary: data.summary || '', outputFields: data.outputFields || [], activeKey: data.layerKey || s.activeKey }));
                            break;
                        case 'draft':
                            finalDraft = data.definition || finalDraft;
                            setState(s => ({ ...s, draft: data.definition || s.draft }));
                            break;
                        case 'done':
                            finalKey = data.layerKey || finalKey;
                            break;
                        case 'error':
                            errMsg = data.error || 'Layer build failed';
                            setState(s => ({ ...s, error: errMsg }));
                            break;
                        default:
                            break;
                    }
                }
            }
        } catch (e) {
            if (!(e instanceof Error) || e.name !== 'AbortError') {
                errMsg = (e instanceof Error && e.message) || 'Stream failed';
                setState(s => ({ ...s, running: false, error: errMsg }));
                return { draft: null, layerKey: finalKey, error: errMsg };
            }
        }
        setState(s => ({ ...s, running: false }));
        return { draft: finalDraft, layerKey: finalKey, error: errMsg };
    }, []);

    return { state, send, cancel, reset };
}

async function safeText(r: Response): Promise<string> {
    try {
        const j = await r.json();
        return j.error || JSON.stringify(j);
    } catch { return r.statusText; }
}
