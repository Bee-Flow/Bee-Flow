import { useEffect, useRef, useState } from 'react';
import {
    previewTable,
    type PreviewFn, type PreviewSource, type TablePreviewRequest, type TablePreviewResponse,
} from '../../api/queries/automation/tablePreview';

/** How long the author has to stop changing things before the server is asked. */
export const PREVIEW_DELAY_MS = 400;

export interface UseTablePreviewArgs {
    automationId: string | null | undefined;
    /** Null while there is no table to look at: nothing is requested. */
    source: PreviewSource | null;
    ops: unknown[];
    /** Preview up to (and including) this operation. */
    upToOpId?: string | null;
    joinSources?: Record<string, PreviewSource>;
    limit?: number;
    enabled?: boolean;
    /** Replaceable, so a test can hand in a fake instead of mocking the module. */
    preview?: PreviewFn;
    delayMs?: number;
}

export interface TablePreviewState {
    status: 'idle' | 'loading' | 'ready' | 'error';
    /** The latest answer. It stays while the next one loads, so the table does not flicker. */
    response: TablePreviewResponse | null;
    error: string | null;
}

const IDLE: TablePreviewState = { status: 'idle', response: null, error: null };

interface Settled { key: string; response: TablePreviewResponse | null; error: string | null }

/**
 * The live preview of a table step: one request per pause in editing, the
 * previous request cancelled when a newer one is due. Keyed on the JSON of
 * what is sent, so a re-render with the same ops asks nothing.
 */
export function useTablePreview(args: UseTablePreviewArgs): TablePreviewState {
    const { automationId, source, ops, upToOpId, joinSources, limit, enabled = true, preview = previewTable, delayMs = PREVIEW_DELAY_MS } = args;
    // The last answer, and which request it answered. Until a newer one arrives it stays on screen.
    const [settled, setSettled] = useState<Settled>({ key: '', response: null, error: null });
    const body: TablePreviewRequest | null = enabled && !!automationId && source
        ? {
            source,
            ops,
            ...(upToOpId ? { upToOpId } : {}),
            ...(joinSources && Object.keys(joinSources).length ? { joinSources } : {}),
            ...(limit ? { limit } : {}),
        }
        : null;
    const key = body ? JSON.stringify(body) : '';
    // The latest of these are read when the timer fires, so they are not dependencies.
    const latest = useRef({ automationId, preview, body });
    useEffect(() => { latest.current = { automationId, preview, body }; });

    useEffect(() => {
        if (!key) return undefined;
        const controller = new AbortController();
        const timer = setTimeout(() => {
            const { automationId: id, preview: run, body: sent } = latest.current;
            if (!id || !sent) return;
            run(id, sent, controller.signal).then(
                response => { if (!controller.signal.aborted) setSettled({ key, response, error: null }); },
                (e: unknown) => {
                    if (controller.signal.aborted) return;
                    setSettled(s => ({ key, response: s.response, error: e instanceof Error ? e.message : String(e) }));
                },
            );
        }, delayMs);
        return () => { clearTimeout(timer); controller.abort(); };
    }, [key, delayMs]);

    if (!key) return IDLE;
    if (settled.key !== key) return { status: 'loading', response: settled.response, error: null };
    return { status: settled.error ? 'error' : 'ready', response: settled.response, error: settled.error };
}
