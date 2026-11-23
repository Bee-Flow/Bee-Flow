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
import { logger } from '@/utils/logger';
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

/** Filling in together: read the document again every `pollMs`, take the others' values, and hand it on. */
export interface LiveOptions {
    pollMs?: number;
    onRemote?: (doc: FillDocument) => void;
}

/** Values another person saved, taken over for every field this person has not changed and not yet saved. */
function mergeRemote(local: Record<string, unknown>, remote: Record<string, unknown>, dirty: Set<string>) {
    const merged = { ...local };
    let changed = false;
    for (const key of new Set([...Object.keys(local), ...Object.keys(remote)])) {
        if (dirty.has(key) || JSON.stringify(local[key]) === JSON.stringify(remote[key])) continue;
        if (remote[key] === undefined) delete merged[key];
        else merged[key] = remote[key];
        changed = true;
    }
    return changed ? merged : null;
}

export default function useTemplateFillForm(doc: FillDocument, api: TemplateFillApi, live: LiveOptions = {}) {
    const [values, setValues] = useState<Record<string, unknown>>(() => ({ ...doc.values }));
    const [issues, setIssues] = useState<Record<string, string>>({});
    const [state, setState] = useState<State>(() => ({ ...localProgress(doc.fields, doc.values), issues: [], finished: doc.finished }));
    const [status, setStatus] = useState<SaveStatus>('idle');
    // Set when "Done" was refused: the labels still missing.
    const [refusedFor, setRefusedFor] = useState<string[] | null>(null);
    const latest = useRef(values);
    const dirty = useRef(new Set<string>());
    const saving = useRef(new Set<string>());
    const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

    useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

    const { pollMs, onRemote } = live;
    const onRemoteRef = useRef(onRemote);
    useEffect(() => { onRemoteRef.current = onRemote; });
    useEffect(() => {
        if (!pollMs) return undefined;
        let stopped = false;
        const tick = async () => {
            try {
                const fresh = await api.load(doc.id);
                if (stopped) return;
                const merged = mergeRemote(latest.current, fresh.values, new Set([...dirty.current, ...saving.current]));
                if (merged) {
                    latest.current = merged;
                    setValues(merged);
                    setState((s) => ({ ...s, ...localProgress(doc.fields, merged), finished: fresh.finished }));
                }
                onRemoteRef.current?.(fresh);
            } catch (err) {
                // The next tick tries again; a failed read changes nothing on screen.
                logger.debug('template fill poll failed', err);
            }
        };
        const handle = setInterval(() => { void tick(); }, pollMs);
        return () => { stopped = true; clearInterval(handle); };
    }, [pollMs, api, doc.id, doc.fields]);

    const save = async (finish = false): Promise<FillProgress | null> => {
        if (timer.current) { clearTimeout(timer.current); timer.current = null; }
        const keys = [...dirty.current];
        dirty.current.clear();
        if (keys.length === 0 && !finish) return null;
        setStatus('saving');
        // While on their way, these fields are still this person's: a poll must not put the old value back.
        for (const k of keys) saving.current.add(k);
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
        } finally {
            for (const k of keys) saving.current.delete(k);
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
