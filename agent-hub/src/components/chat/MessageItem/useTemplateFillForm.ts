/**
 * The state of one fill-in form: what the person typed, saving it a moment
 * after they stop typing (PUT /api/studio-documents/:id/values, all fields
 * changed since the last save in one request, one save at a time), the reason
 * next to a field the server refused, where the filling stands, the
 * assistant's final check, and "Check and finish".
 *
 * WHAT OTHERS FILL IN ARRIVES IN PLACE. A new read of the document (the
 * assistant stored values in this turn, a colleague saved in the project) is
 * merged into the form: every field takes the new value except the ones this
 * person is changing right now. Nothing is remounted, so typing is never lost.
 * What is still unsaved when the form goes away is sent on the way out.
 *
 * Nothing is posted into the chat: the assistant reads the form's edits
 * itself (template_fill_status) on the next turn.
 */
import { useEffect, useRef, useState, type MutableRefObject } from 'react';

import type { FillDocument, FillProgress, SaveOptions, TemplateFillApi } from '@/api/templateFillApi';
import { NO_TEAM, type FillTeam } from '@/api/templateFillTeamApi';
import { messageOf } from '@/utils/caughtError';
import { logger } from '@/utils/logger';
import { localProgress, wireValue } from './templateFillModel';

const SAVE_DELAY_MS = 600;

export type SaveStatus = 'idle' | 'saving' | 'saved' | 'error';
/** Where the form is: filling in, ready for the final check, checked (ready to finish), finished. */
export type FillPhase = 'fill' | 'check' | 'finish' | 'done';
interface CheckState { busy: boolean; error: string | null }

interface State {
    missingRequired: Array<{ key: string; label: string }>;
    issues: string[];
    filled: number;
    total: number;
    complete: boolean;
    finished: boolean;
}

type Values = Record<string, unknown>;

function stateOf(out: FillProgress): State {
    return { missingRequired: out.missingRequired, issues: out.issues, filled: out.filled, total: out.total, complete: out.complete, finished: out.finished };
}

/** Filling in together: read the document again every `pollMs`; `onSynced` hears every answer of the server. */
export interface LiveOptions {
    pollMs?: number;
    onSynced?: (out: { versionId?: string | null }) => void;
}

/** Values another writer saved, taken over for every field this person is not changing right now. */
function mergeRemote(local: Values, remote: Values, mine: Set<string>) {
    const merged = { ...local };
    let changed = false;
    for (const key of new Set([...Object.keys(local), ...Object.keys(remote)])) {
        if (mine.has(key) || JSON.stringify(local[key]) === JSON.stringify(remote[key])) continue;
        if (remote[key] === undefined) delete merged[key];
        else merged[key] = remote[key];
        changed = true;
    }
    return changed ? merged : null;
}

interface Core {
    doc: FillDocument;
    api: TemplateFillApi;
    latest: MutableRefObject<Values>;
    dirty: MutableRefObject<Set<string>>;
    saving: MutableRefObject<Set<string>>;
    alive: MutableRefObject<boolean>;
    stateRef: MutableRefObject<State>;
    teamRef: MutableRefObject<FillTeam>;
    setValues: (v: Values) => void;
    setState: (s: State) => void;
    setTeam: (t: FillTeam) => void;
    onSynced: MutableRefObject<LiveOptions['onSynced']>;
}

/** The pieces every part of the form shares: the values as typed, what is unsaved, and the server's last word. */
function useCore(doc: FillDocument, api: TemplateFillApi, live: LiveOptions) {
    const [values, setValuesState] = useState<Values>(() => ({ ...doc.values }));
    const [state, setStateValue] = useState<State>(() => ({ ...localProgress(doc.fields, doc.values), issues: [], finished: doc.finished }));
    const [team, setTeamValue] = useState<FillTeam>(() => doc.team ?? NO_TEAM);
    const latest = useRef(values);
    const stateRef = useRef(state);
    const teamRef = useRef(team);
    const onSynced = useRef(live.onSynced);
    useEffect(() => { onSynced.current = live.onSynced; });
    const core: Core = {
        doc, api, latest, stateRef, teamRef, onSynced,
        dirty: useRef(new Set<string>()), saving: useRef(new Set<string>()), alive: useRef(true),
        setValues: (v) => { latest.current = v; setValuesState(v); },
        setState: (s) => { stateRef.current = s; setStateValue(s); },
        setTeam: (t) => { teamRef.current = t; setTeamValue(t); },
    };
    return { core, values, state, team };
}

/** What these fields send. */
const wireValues = (values: Values, keys: string[]): Values => Object.fromEntries(keys.map((k) => [k, wireValue(values[k])]));

/** Take a server answer: where the filling stands, and what is shown next to the values. */
function take(core: Core, out: FillProgress) {
    core.setState(stateOf(out));
    if (out.team) core.setTeam(out.team);
    core.onSynced.current?.(out);
}

type Timer = MutableRefObject<ReturnType<typeof setTimeout> | null>;

/** The form goes away: what was typed and not sent yet is sent now, so leaving the form (or the chat) loses nothing. */
function leaveForm({ api, id, alive, dirty, latest, timer }: Pick<Core, 'api' | 'alive' | 'dirty' | 'latest'> & { id: string; timer: Timer }) {
    alive.current = false;
    if (timer.current) clearTimeout(timer.current);
    const keys = [...dirty.current];
    if (keys.length) api.save(id, wireValues(latest.current, keys)).catch((err) => logger.debug('template fill save on leave failed', err));
}

/** Saving: one request at a time, the changed fields of that moment in each, and the rest on the way out. */
function useSaver(core: Core) {
    const [issues, setIssues] = useState<Record<string, string>>({});
    const [status, setStatus] = useState<SaveStatus>('idle');
    const timer: Timer = useRef(null);
    const queue = useRef<Promise<unknown>>(Promise.resolve());
    const { doc, api, dirty, saving, latest, alive } = core;

    useEffect(() => {
        alive.current = true;
        return () => leaveForm({ api, id: doc.id, alive, dirty, latest, timer });
    }, [api, doc.id, alive, dirty, latest]);

    const send = async (options: SaveOptions): Promise<FillProgress | null> => {
        if (timer.current) { clearTimeout(timer.current); timer.current = null; }
        const keys = [...dirty.current];
        dirty.current.clear();
        if (keys.length === 0 && !options.finish && !options.dismiss?.length) return null;
        setStatus('saving');
        // While on their way, these fields are still this person's: a new read must not put the old value back.
        for (const k of keys) saving.current.add(k);
        try {
            const out = await api.save(doc.id, wireValues(latest.current, keys), options);
            if (!alive.current) return out;
            setIssues((prev) => {
                const next = { ...prev };
                for (const k of keys) delete next[k];
                for (const r of out.rejected) next[r.key] = r.message;
                return next;
            });
            take(core, out);
            setStatus('saved');
            return out;
        } catch (err) {
            logger.debug('template fill save failed', err);
            for (const k of keys) dirty.current.add(k);
            if (alive.current) setStatus('error');
            return null;
        } finally {
            for (const k of keys) saving.current.delete(k);
        }
    };

    /** Queued behind the save that is on its way, so two saves never cross. */
    const save = (options: SaveOptions = {}): Promise<FillProgress | null> => {
        const next = queue.current.then(() => send(options));
        queue.current = next;
        return next;
    };

    const onChange = (key: string, value: unknown) => {
        core.setValues({ ...latest.current, [key]: value });
        dirty.current.add(key);
        setStatus('idle');
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => { void save(); }, SAVE_DELAY_MS);
    };

    return { issues, status, save, onChange };
}

/** What others saved: a new read handed in (`doc`), and in a project a read every `pollMs`. */
function useRemote(core: Core, pollMs: number | undefined) {
    const { doc, api, latest, dirty, saving, alive, onSynced } = core;
    const absorb = (fresh: FillDocument) => {
        const merged = mergeRemote(latest.current, fresh.values, new Set([...dirty.current, ...saving.current]));
        if (merged) core.setValues(merged);
        if (merged || fresh.finished !== core.stateRef.current.finished) {
            core.setState({ ...core.stateRef.current, ...localProgress(doc.fields, latest.current), finished: fresh.finished });
        }
        if (fresh.team) core.setTeam(fresh.team);
    };
    const absorbRef = useRef(absorb);
    useEffect(() => { absorbRef.current = absorb; });

    // The same document read again by the caller (a new tool result in a live turn): merged, never remounted.
    const first = useRef(doc);
    useEffect(() => {
        if (first.current === doc) return;
        first.current = doc;
        absorbRef.current(doc);
    }, [doc]);

    useEffect(() => {
        if (!pollMs) return undefined;
        const tick = async () => {
            try {
                const fresh = await api.load(doc.id);
                if (!alive.current) return;
                absorbRef.current(fresh);
                onSynced.current?.(fresh);
            } catch (err) {
                // The next tick tries again; a failed read changes nothing on screen.
                logger.debug('template fill poll failed', err);
            }
        };
        const handle = setInterval(() => { void tick(); }, pollMs);
        return () => clearInterval(handle);
    }, [pollMs, api, doc.id, alive, onSynced]);
}

/** A remark the person dealt with leaves the form at once; the server's answer confirms it. */
function withoutRemark(team: FillTeam, key: string): FillTeam {
    return team.review ? { ...team, review: { ...team.review, findings: team.review.findings.filter((f) => f.key !== key) } } : team;
}

/** The assistant's final check, and what the person does with its remarks. */
function useFinalCheck(core: Core, saver: ReturnType<typeof useSaver>) {
    const [check, setCheck] = useState<CheckState>({ busy: false, error: null });
    const { doc, api, alive, teamRef } = core;

    const runCheck = async (): Promise<FillProgress | null> => {
        if (!api.review) return null;
        await saver.save();
        setCheck({ busy: true, error: null });
        try {
            const out = await api.review(doc.id);
            if (alive.current) { take(core, out); setCheck({ busy: false, error: null }); }
            return out;
        } catch (err) {
            if (alive.current) setCheck({ busy: false, error: messageOf(err, '') });
            return null;
        }
    };
    /** Take the suggested wording over: a plain save of that value, which also answers the remark. */
    const acceptRemark = (key: string) => {
        const remark = teamRef.current.review?.findings.find((f) => f.key === key);
        if (!remark || remark.suggestion === undefined) return;
        saver.onChange(key, remark.suggestion);
        core.setTeam(withoutRemark(teamRef.current, key));
        void saver.save();
    };
    /** Keep the value as it is: the remark goes. */
    const dismissRemark = (key: string) => {
        core.setTeam(withoutRemark(teamRef.current, key));
        void saver.save({ dismiss: [key] });
    };
    return { check, runCheck, acceptRemark, dismissRemark };
}

function phaseOf(state: State, team: FillTeam, check: CheckState, canCheck: boolean): FillPhase {
    if (state.finished) return 'done';
    if (!state.complete) return 'fill';
    return team.review || check.error !== null || !canCheck ? 'finish' : 'check';
}

export default function useTemplateFillForm(doc: FillDocument, api: TemplateFillApi, live: LiveOptions = {}) {
    const { core, values, state, team } = useCore(doc, api, live);
    const saver = useSaver(core);
    useRemote(core, live.pollMs);
    const final = useFinalCheck(core, saver);
    // Set when "Check and finish" was refused: the labels still missing.
    const [refusedFor, setRefusedFor] = useState<string[] | null>(null);
    const phase = phaseOf(state, team, final.check, !!api.review);

    /** The one button: what is missing, else the final check once, else finished. */
    const onDone = async () => {
        const saved = await saver.save();
        const now = saved ? stateOf(saved) : core.stateRef.current;
        if (!now.complete) { setRefusedFor(now.missingRequired.map((m) => m.label)); return; }
        setRefusedFor(null);
        if (phaseOf(now, core.teamRef.current, final.check, !!api.review) === 'check') {
            const checked = await final.runCheck();
            // No check (the person can finish without it), or remarks to go through first.
            if (!checked || (checked.team?.review?.findings.length ?? 0) > 0) return;
        }
        const out = await saver.save({ finish: true });
        if (out && !out.finished) setRefusedFor(out.missingRequired.map((m) => m.label));
    };

    return {
        values, issues: saver.issues, state, status: saver.status, team, phase, check: final.check, refusedFor,
        onChange: saver.onChange, onDone, runCheck: final.runCheck, acceptRemark: final.acceptRemark, dismissRemark: final.dismissRemark,
        setTeam: core.setTeam,
    };
}

export type TemplateFillFormState = ReturnType<typeof useTemplateFillForm>;
