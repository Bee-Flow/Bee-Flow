import { useCallback, useEffect, useRef, useState } from 'react';
import { applyPhaseResult, kindOf, patchFor, SERVER_RUN } from './phaseMachine';
import { playbooksApi } from './playbooksApi';

const POLL_MS = 2000;
const POLL_MAX_MS = 16000;

/**
 * The playbook entity on the page: load, poll while the server runs a phase
 * (table, fill), apply the page's events optimistically and let the server's
 * answer replace the whole entity. A 409 means the playbook moved under us
 * (another tab, a late builder callback): reload, never retry blindly.
 *
 *   usePlaybook(id) → { playbook, loading, error, conflict, reload, dispatch(event, base?), polling }
 *   reload({ quiet }) — the POLL passes quiet, so a message the person is
 *   reading is not wiped two seconds later by a GET that happened to succeed.
 *   dispatch resolves to the server's playbook (null on failure); pass it as
 *   `base` to chain a second event on the fresh version.
 *   event: { type: 'start'|'artifact'|'finished'|'markDone'|'failed'|'continue'|'revise'|'skip'|'retry'|'stop'|'resume'|'needs_input'|'dismiss_input'|'replace', key, … }
 */
export default function usePlaybook(id) {
    const [playbook, setPlaybook] = useState(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);
    const [conflict, setConflict] = useState(0);
    const aliveRef = useRef(true);
    const playbookRef = useRef(null);
    useEffect(() => { playbookRef.current = playbook; }, [playbook]);
    useEffect(() => () => { aliveRef.current = false; }, []);

    const reload = useCallback(async ({ quiet = false } = {}) => {
        if (!id) return null;
        try {
            const body = await playbooksApi.get(id);
            if (!aliveRef.current) return null;
            playbookRef.current = body.playbook;
            setPlaybook(body.playbook);
            if (!quiet) setError(null);
            return body.playbook;
        } catch (e) {
            if (aliveRef.current && !quiet) setError(e);
            return null;
        } finally {
            if (aliveRef.current) setLoading(false);
        }
    }, [id]);

    useEffect(() => { setLoading(true); reload(); }, [reload]);

    // Poll while a server-run phase is running; pause in a hidden tab.
    //
    // Only while the playbook is ACTIVE: Stop changes the playbook's status but
    // leaves its phases `running`, so a stopped run used to poll for ever
    // behind the done card — 30 of the router's 60 requests a minute, per tab.
    // A failure backs off rather than hammering, and the poll is `quiet`: it
    // must never clear an error the person is still reading.
    const polling = !!(playbook && playbook.status === 'active' && Array.isArray(playbook.phases)
        && playbook.phases.some((p) => SERVER_RUN.has(kindOf(p)) && p.status === 'running'));
    useEffect(() => {
        if (!polling) return undefined;
        let timer = null;
        let wait = POLL_MS;
        const tick = async () => {
            if (typeof document === 'undefined' || document.visibilityState !== 'hidden') {
                const got = await reload({ quiet: true });
                wait = got ? POLL_MS : Math.min(POLL_MAX_MS, wait * 2);
            }
            if (aliveRef.current) timer = setTimeout(tick, wait);
        };
        timer = setTimeout(tick, wait);
        return () => { if (timer) clearTimeout(timer); };
    }, [polling, reload]);

    // Set state AND the ref at once, so two events in one tick see one version.
    const commit = useCallback((pb) => { playbookRef.current = pb; setPlaybook(pb); }, []);

    const dispatch = useCallback(async (event, base = null) => {
        const current = base || playbookRef.current;
        if (!current || !event) return null;
        // A stage that already HAS the server's answer (the compliance phase's
        // Register call returns the whole playbook) hands it over instead of
        // asking for it again — no second write, no refetch.
        if (event.type === 'replace') {
            if (event.playbook) commit(event.playbook);
            return event.playbook || current;
        }
        if (event.type === 'needs_input' || event.type === 'dismiss_input') {
            setPlaybook((pb) => (pb ? { ...pb, phases: applyPhaseResult(pb.phases, event.key, { kind: event.type }) } : pb));
            return current;
        }
        const wire = patchFor(event, current);
        if (!wire) return current;
        // Optimistic: the rail moves before the answer.
        const optimistic = {
            start: 'started', artifact: 'artifacts', finished: 'finished', markDone: 'finished', failed: 'failed', continue: 'done', skip: 'skipped',
        }[event.type];
        if (optimistic) setPlaybook((pb) => (pb ? { ...pb, phases: applyPhaseResult(pb.phases, event.key, { kind: optimistic, ...event }) } : pb));
        try {
            let body;
            if (wire.method === 'POST') {
                if (wire.route.endsWith('/run')) body = await playbooksApi.runPhase(current.id, event.key, wire.body || {});
                else if (wire.route.endsWith('/skip')) body = await playbooksApi.skipPhase(current.id, event.key, current.version);
                else body = await playbooksApi.retryPhase(current.id, event.key, current.version, event.extra || {});
            } else {
                body = await playbooksApi.patch(current.id, wire.body);
            }
            if (aliveRef.current && body && body.playbook) { commit(body.playbook); setError(null); }
            return body ? body.playbook : null;
        } catch (e) {
            if (!aliveRef.current) return null;
            // A 409 is NOT a synonym for "someone else changed this". The route
            // answers 409 for `routine_not_finalized`, `key_taken`,
            // `artifacts_missing`, `capability_missing` and every illegal
            // transition too, and those have to reach the person in words —
            // the page used to file all of them under "changed elsewhere" and
            // then suppress the bar, so the primary button silently did
            // nothing (owner, on stage).
            if (e && e.body && e.body.playbook) commit(e.body.playbook);
            else await reload({ quiet: true });
            if (e && e.code === 'version_conflict') setConflict((n) => n + 1);
            setError(e);
            return null;
        }
    }, [reload, commit]);

    return { playbook, loading, error, conflict, reload, dispatch, polling };
}
