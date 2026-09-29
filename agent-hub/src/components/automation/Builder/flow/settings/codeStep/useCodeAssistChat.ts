// The code assistant's conversation: one turn per question, streamed from
// POST /api/automation/builder/code/assist.
//
// The server edits a COPY of the code and sends the result once, at the end
// of the turn (after its own repair rounds). The new code lands in the draft
// straight away, so the editor, the checks and "Try it" see it, and the turn
// keeps the code as it was before, so Undo puts it back. Keep just closes the
// question: the draft autosaves like any other edit.
import { useCallback, useRef, useState } from 'react';
import { streamCodeAssist, type AssistMessage } from '../../../../../../api/queries/automation/codeStep';

export type TurnStatus = 'streaming' | 'done' | 'failed' | 'stopped';

export interface AssistTurn {
    id: number;
    ask: string;
    reply: string;
    edits: Array<{ op: string; summary: string }>;
    status: TurnStatus;
    error: string | null;
    /** The code before the turn, when the turn changed it. */
    before: string | null;
    /** The code the turn produced, when it changed it. */
    after: string | null;
    /** null: nothing to decide; 'kept' or 'undone' once the person chose. */
    decision: 'kept' | 'undone' | null;
}

export interface CodeAssistContext {
    code: string;
    setCode: (code: string) => void;
    allowedTools: string[];
    allowedHosts: string[];
    upstreamFields: Array<{ path: string; label: string; type: string }>;
    automationId: string | null;
    stepId: string | null;
}

/** The conversation so far, as the server expects it: text only, oldest first. */
export function historyOf(turns: AssistTurn[]): AssistMessage[] {
    const out: AssistMessage[] = [];
    for (const turn of turns) {
        if (turn.status === 'streaming') continue;
        out.push({ role: 'user', content: turn.ask });
        if (turn.reply.trim()) out.push({ role: 'assistant', content: turn.reply });
    }
    return out;
}

export function useCodeAssistChat(ctx: CodeAssistContext) {
    const [turns, setTurns] = useState<AssistTurn[]>([]);
    const [busy, setBusy] = useState(false);
    const abortRef = useRef<AbortController | null>(null);
    const seq = useRef(0);
    // The latest context without re-creating send() on every keystroke.
    const ctxRef = useRef(ctx);
    ctxRef.current = ctx;

    const patch = useCallback((id: number, fn: (t: AssistTurn) => AssistTurn) => {
        setTurns((all) => all.map((t) => (t.id === id ? fn(t) : t)));
    }, []);

    const send = useCallback(async (text: string) => {
        const ask = text.trim();
        if (!ask || busy) return;
        const c = ctxRef.current;
        const id = ++seq.current;
        const startCode = c.code;
        const history = historyOf(turns);
        setTurns((all) => [...all, { id, ask, reply: '', edits: [], status: 'streaming', error: null, before: null, after: null, decision: null }]);
        setBusy(true);
        const ac = new AbortController();
        abortRef.current = ac;
        try {
            await streamCodeAssist({
                messages: [...history, { role: 'user', content: ask }],
                code: startCode,
                allowedTools: c.allowedTools,
                allowedHosts: c.allowedHosts,
                upstreamFields: c.upstreamFields,
                automationId: c.automationId,
                stepId: c.stepId,
            }, (e) => {
                if (e.type === 'delta') patch(id, (t) => ({ ...t, reply: t.reply + e.text }));
                else if (e.type === 'edit') patch(id, (t) => ({ ...t, edits: [...t.edits, { op: e.op, summary: e.summary }] }));
                else if (e.type === 'error') patch(id, (t) => ({ ...t, error: e.message || null }));
                else if (e.type === 'code' && e.code !== startCode) {
                    ctxRef.current.setCode(e.code);
                    patch(id, (t) => ({ ...t, before: startCode, after: e.code }));
                }
            }, ac.signal);
            patch(id, (t) => ({ ...t, status: t.error ? 'failed' : 'done' }));
        } catch (err) {
            const stopped = ac.signal.aborted;
            patch(id, (t) => ({ ...t, status: stopped ? 'stopped' : 'failed', error: stopped ? null : ((err as Error)?.message || 'failed') }));
        } finally {
            abortRef.current = null;
            setBusy(false);
        }
    }, [busy, turns, patch]);

    const stop = useCallback(() => { abortRef.current?.abort(); }, []);

    const keep = useCallback((id: number) => patch(id, (t) => ({ ...t, decision: 'kept' })), [patch]);

    const undo = useCallback((id: number) => {
        const turn = turns.find((t) => t.id === id);
        if (!turn || turn.before == null) return;
        ctxRef.current.setCode(turn.before);
        patch(id, (t) => ({ ...t, decision: 'undone' }));
    }, [turns, patch]);

    return { turns, busy, send, stop, keep, undo };
}
