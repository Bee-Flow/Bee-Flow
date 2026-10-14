import { useEffect, useMemo, useRef, useState } from 'react';

/**
 * The inline-edit pipeline of the App Studio data grid: the optimistic
 * overlay, the single-flight commit queue, the rollback on a failed update and
 * the reconciliation with refetched rows. Moved out of AppDataGrid.jsx
 * verbatim; the hook's effects run in the same order they did inline.
 */

type GridRecord = Record<string, any>;
type RunAction = (actionId: string, payload: Record<string, unknown>) => unknown;
interface PendingCommit { rk: string; key: string }
interface QueuedCommit extends PendingCommit { formValues: GridRecord }

export const rowKey = (row: GridRecord | null | undefined, index: number): string => String(row?.id ?? row?._id ?? index);

interface EditQueueArgs {
    baseRows: GridRecord[];
    onRowSelect: string | undefined;
    actionState: Record<string, { status?: string } | undefined> | undefined;
    runAction: RunAction;
}

export function useGridEditQueue({ baseRows, onRowSelect, actionState, runAction }: EditQueueArgs) {
    // Local, optimistic inline-edit overlay keyed by a stable row id. It is a
    // bridge to the save, NOT a store: it is rolled back when the update action
    // fails and dropped as soon as fresher rows arrive.
    const [edits, setEdits] = useState<Record<string, GridRecord>>({});
    // Commit pipeline. useActionRunner's re-entry guard silently drops a run of
    // an action that is still 'running' — so a second cell committed during the
    // first commit's round-trip used to never save, and its overlay value
    // visibly snapped back on the next refetch. One commit is in flight at a
    // time (`inFlight` — the rollback targets); the rest wait in `commitQueue`
    // and dispatch as the previous one settles.
    const inFlight = useRef<PendingCommit[]>([]);      // [{ rk, key }] of the dispatched, unsettled commit
    const commitQueue = useRef<QueuedCommit[]>([]);   // [{ formValues, rk, key }] waiting to dispatch
    const busy = useRef(false);

    const data = useMemo(() => baseRows.map((row, index) => {
        const ov = edits[rowKey(row, index)];
        return ov ? { ...row, ...ov } : row;
    }), [baseRows, edits]);

    // Refetched rows are the server's answer and outrank any pending overlay —
    // otherwise a value the server rewrote (or never accepted) stays on screen.
    // The exception is values still QUEUED behind an in-flight commit: their
    // write has not happened yet, so the refetch cannot be their answer, and
    // dropping them would snap the cell back mid-queue only for the value to
    // reappear after its own commit's refresh.
    const seenRows = useRef(baseRows);
    useEffect(() => {
        if (seenRows.current === baseRows) return;
        seenRows.current = baseRows;
        inFlight.current = [];
        const queued = new Set(commitQueue.current.map((e) => `${e.rk}\u0000${e.key}`));
        setEdits((prev) => {
            if (!Object.keys(prev).length) return prev;
            if (!queued.size) return {};
            const next: Record<string, GridRecord> = {};
            for (const [rk, row] of Object.entries(prev)) {
                const kept: GridRecord = {};
                for (const [key, v] of Object.entries(row)) {
                    if (queued.has(`${rk}\u0000${key}`)) kept[key] = v;
                }
                if (Object.keys(kept).length) next[rk] = kept;
            }
            return next;
        });
    }, [baseRows]);

    // A failed update must not keep showing the user's value as if it saved:
    // runAction never rejects, it reports through actionState. On settle
    // (success OR error) the next queued commit — if any — is dispatched.
    const updateStatus = onRowSelect ? actionState?.[onRowSelect]?.status : undefined;
    const prevUpdateStatus = useRef(updateStatus);
    useEffect(() => {
        const prev = prevUpdateStatus.current;
        prevUpdateStatus.current = updateStatus;
        if (prev === updateStatus) return;
        if (updateStatus !== 'success' && updateStatus !== 'error') return;
        const rolled = inFlight.current;
        inFlight.current = [];
        if (updateStatus === 'error' && rolled.length) {
            setEdits((cur) => {
                const next = { ...cur };
                for (const { rk, key } of rolled) {
                    if (!next[rk]) continue;
                    const row = { ...next[rk] };
                    delete row[key];
                    if (Object.keys(row).length) next[rk] = row; else delete next[rk];
                }
                return next;
            });
        }
        const entry = commitQueue.current[0];
        if (entry && onRowSelect) {
            commitQueue.current = commitQueue.current.slice(1);
            inFlight.current = [{ rk: entry.rk, key: entry.key }];
            // A queued edit to the row we JUST wrote is carrying the updated_at
            // it was captured with — which our own successful write has already
            // superseded. An action using it for a compare-and-set would then
            // refuse the second edit as somebody else's conflict, and roll it
            // back: edit two cells quickly and the second silently reverts. The
            // guard is there to catch OTHER people, so drop the stale token
            // rather than pointing it at ourselves. (actionExecutor treats a
            // non-string expectedUpdatedAt as absent and skips the check.)
            const values = (updateStatus === 'success' && rolled.some((r) => r.rk === entry.rk))
                ? { ...entry.formValues, updated_at: null }
                : entry.formValues;
            runAction(onRowSelect, { formValues: values, item: values });
        } else {
            busy.current = false;
        }
    }, [updateStatus, runAction, onRowSelect]);

    // UNCHANGED. The optimistic overlay, the single-flight queue and the
    // rollback above are the subtle part of the grid; an editable cell calls
    // this with its row, the row's index, the column key and the new value.
    const commitEdit = (original: GridRecord, index: number, colKey: string, next: unknown) => {
        const rk = rowKey(original, index);
        setEdits((prev) => ({ ...prev, [rk]: { ...(prev[rk] || {}), [colKey]: next } }));
        if (!onRowSelect) return;
        const entry = {
            formValues: { ...original, [colKey]: next, __edited: colKey },
            rk, key: colKey,
        };
        // One commit at a time: fired while the previous
        // one is live it would be swallowed by the
        // runner's re-entry guard, not saved.
        if (busy.current) {
            commitQueue.current = [...commitQueue.current, entry];
            return;
        }
        busy.current = true;
        inFlight.current = [{ rk, key: colKey }];
        runAction(onRowSelect, { formValues: entry.formValues, item: entry.formValues });
    };

    return { data, commitEdit };
}
