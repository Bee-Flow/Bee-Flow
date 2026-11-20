/**
 * The state of one template-fill form: what the person typed, saving it a
 * moment after they stop typing (PUT /api/studio-documents/:id/values, all
 * fields changed since the last save in one request), the reason next to a
 * field the server refused, where the filling stands, and "Done".
 *
 * Nothing is posted into the chat: the assistant reads the form's edits
 * itself (template_fill_status) on the next turn.
 */
import { useEffect, useRef, useState } from 'react';

import type { FillDocument, FillProgress, TemplateFillApi } from '@/api/templateFillApi';
import { localProgress, wireValue } from './templateFillModel';

const SAVE_DELAY_MS = 600;

export type SaveStatus = 'idle' | 'saving' | 'saved' | 'error';

interface State {
    missingRequired: Array<{ key: string; label: string }>;
    issues: string[];
    filled: number;
    total: number;
    complete: boolean;
    finished: boolean;
}

function stateOf(out: FillProgress): State {
    return { missingRequired: out.missingRequired, issues: out.issues, filled: out.filled, total: out.total, complete: out.complete, finished: out.finished };
}

export default function useTemplateFillForm(doc: FillDocument, api: TemplateFillApi) {
    const [values, setValues] = useState<Record<string, unknown>>(() => ({ ...doc.values }));
    const [issues, setIssues] = useState<Record<string, string>>({});
    const [state, setState] = useState<State>(() => ({ ...localProgress(doc.fields, doc.values), issues: [], finished: doc.finished }));
    const [status, setStatus] = useState<SaveStatus>('idle');
    // Set when "Done" was refused: the labels still missing.
    const [refusedFor, setRefusedFor] = useState<string[] | null>(null);
    const latest = useRef(values);
    const dirty = useRef(new Set<string>());
    const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

    useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

    const save = async (finish = false): Promise<FillProgress | null> => {
        if (timer.current) { clearTimeout(timer.current); timer.current = null; }
        const keys = [...dirty.current];
        dirty.current.clear();
        if (keys.length === 0 && !finish) return null;
        setStatus('saving');
        try {
            const out = await api.save(doc.id, Object.fromEntries(keys.map((k) => [k, wireValue(latest.current[k])])), finish);
            setIssues((prev) => {
                const next = { ...prev };
                for (const k of keys) delete next[k];
                for (const r of out.rejected) next[r.key] = r.message;
                return next;
            });
            setState(stateOf(out));
            setStatus('saved');
            return out;
        } catch {
            for (const k of keys) dirty.current.add(k);
            setStatus('error');
            return null;
        }
    };

    const onChange = (key: string, value: unknown) => {
        latest.current = { ...latest.current, [key]: value };
        setValues(latest.current);
        dirty.current.add(key);
        setStatus('idle');
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => { void save(); }, SAVE_DELAY_MS);
    };

    const onDone = async () => {
        const out = await save(true);
        if (out) setRefusedFor(out.finished ? null : out.missingRequired.map((m) => m.label));
    };

    return { values, issues, state, status, refusedFor, onChange, onDone };
}
