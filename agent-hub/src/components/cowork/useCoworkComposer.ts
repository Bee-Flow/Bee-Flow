/**
 * Shared state for "turn this brief into work": when it runs, how often, and
 * which agent does it. Used by both entry points so they behave identically —
 * the Cowork switch in the chat composer and the Cowork page's own composer.
 *
 * The user types one sentence. On send, the server reads that sentence and
 * works out the title, the runnable instruction and the schedule
 * ("elke ochtend" → daily at 08:00), so nobody has to translate their own
 * request into three chips before anything happens.
 *
 * Whatever the user set by hand wins. Each chip records that it was touched,
 * and a touched chip is never overwritten by the composer — the AI fills in
 * the blanks, it does not overrule a decision the user already made.
 */
import { useCallback, useEffect, useState } from 'react';
import { composeCowork, createCowork, listCoworkAgents } from './coworkApi';
import {
    buildCoworkPayload, titleFromBrief, describeSchedule, resolveWhen,
    nextOccurrence, toDateInput, toTimeInput,
} from './coworkSchedule';
import useTranslation from '../../hooks/useTranslation';
import { useEntitlements } from '../licensing/EntitlementsContext';
import type {
    CoworkAgent, CoworkItem, CoworkPayload, CoworkSpec, WhenState,
} from './cowork.types';
import { messageOf } from '../../utils/caughtError';

export interface UseCoworkComposerOptions {
    enabled?: boolean;
    onCreated?: (created: CoworkItem, payload: CoworkPayload, spec: CoworkSpec | null) => void;
}

interface Touched {
    when: boolean;
    repeat: boolean;
    agent: boolean;
}

export interface UseCoworkComposerReturn {
    when: WhenState;
    setWhen: (value: WhenState) => void;
    repeatInterval: string;
    setRepeatInterval: (value: string) => void;
    agentId: string;
    setAgentId: (value: string) => void;
    enabledApps: string[] | null;
    setEnabledApps: (value: string[] | null) => void;
    agents: CoworkAgent[];
    touched: Touched;
    submitting: boolean;
    error: string | null;
    setError: (value: string | null) => void;
    scheduleReady: boolean;
    summary: string;
    submit: (brief: string, opts?: { modelTier?: string }) => Promise<CoworkItem | null>;
    reset: () => void;
}

const DEFAULT_WHEN: WhenState = { presetId: 'now', date: '', time: '' };

export default function useCoworkComposer({ enabled = true, onCreated }: UseCoworkComposerOptions = {}): UseCoworkComposerReturn {
    // The two errors this hook raises itself are shown in the composer, so they
    // are copy like any other. A server-sent `err.message` is NOT translated
    // here — it is the server's sentence, and inventing a key per message would
    // silently swallow the real reason.
    const { t } = useTranslation();
    const [when, setWhenState] = useState<WhenState>(DEFAULT_WHEN);
    const [repeatInterval, setRepeatState] = useState('');
    const [agentId, setAgentState] = useState('');
    // Which apps this one item may touch. null until the user opens the Apps
    // picker — that keeps "I didn't choose" (inherit the workspace-wide list)
    // distinct from "I chose nothing" (an empty array, a real answer).
    const [enabledApps, setEnabledApps] = useState<string[] | null>(null);
    const [agents, setAgents] = useState<CoworkAgent[]>([]);
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState<string | null>(null);
    // Which chips the user (or the surrounding chat) decided for themselves.
    const [touched, setTouched] = useState<Touched>({ when: false, repeat: false, agent: false });

    const ent = useEntitlements() as { loading: boolean; can: (id: string) => boolean };
    // Handing work to an agent is the same beta the server gates POST on — no
    // point offering the picker if the create call would 403.
    const canPickAgent = !!ent && !ent.loading && typeof ent.can === 'function' && ent.can('agent_routines');

    useEffect(() => {
        if (!enabled || !canPickAgent) { setAgents([]); return undefined; }
        let cancelled = false;
        listCoworkAgents()
            .then(list => { if (!cancelled) setAgents(list); })
            .catch(() => { if (!cancelled) setAgents([]); });
        return () => { cancelled = true; };
    }, [enabled, canPickAgent]);

    // Every setter the UI calls marks its chip as the user's choice. Seeding
    // the agent from an agent chat goes through setAgentId too, and that is
    // deliberate: if you are talking to an agent and delegate something, you
    // mean that agent — the composer must not reassign it.
    const setWhen = useCallback((value: WhenState) => {
        setWhenState(value);
        setTouched(t => (t.when ? t : { ...t, when: true }));
    }, []);
    const setRepeatInterval = useCallback((value: string) => {
        setRepeatState(value);
        setTouched(t => (t.repeat ? t : { ...t, repeat: true }));
    }, []);
    const setAgentId = useCallback((value: string) => {
        setAgentState(value);
        setTouched(t => (t.agent ? t : { ...t, agent: true }));
    }, []);

    const reset = useCallback(() => {
        setWhenState(DEFAULT_WHEN);
        setRepeatState('');
        setAgentState('');
        setEnabledApps(null);
        setTouched({ when: false, repeat: false, agent: false });
        setError(null);
    }, []);

    // 'custom' with empty inputs is the one unschedulable state — block send
    // rather than silently falling back to "now".
    const scheduleReady = !!resolveWhen(when.presetId, when);

    const submit = useCallback(async (brief: string, { modelTier }: { modelTier?: string } = {}) => {
        const text = String(brief || '').trim();
        if (!text || submitting) return null;

        setSubmitting(true);
        setError(null);
        try {
            // A composer failure must never cost the user their work — fall
            // back to their own words, which is what they got before this
            // existed. The server already degrades this way; this catch covers
            // the network too.
            let spec: CoworkSpec | null = null;
            try {
                spec = await composeCowork(text);
            } catch (_) { spec = null; }

            const useRepeat = touched.repeat ? repeatInterval : (spec?.repeatInterval || '');
            const useAgent = touched.agent ? agentId : (spec?.agentId || '');
            const useDays = touched.when ? null : (spec?.daysOfWeek || null);

            // A composed time becomes a concrete first run: the next one that
            // has not happened yet, so a daily 08:00 job created at 09:00
            // starts tomorrow rather than firing immediately.
            let useWhen: WhenState = when;
            if (!touched.when && spec?.timeOfDay) {
                const first = nextOccurrence(spec.timeOfDay, spec.daysOfWeek);
                if (first) {
                    useWhen = { presetId: 'custom', date: toDateInput(first), time: toTimeInput(first) };
                }
            }

            const payload = buildCoworkPayload({
                title: spec?.title || titleFromBrief(text),
                prompt: spec?.prompt || text,
                presetId: useWhen.presetId,
                date: useWhen.date,
                time: useWhen.time,
                repeatInterval: useRepeat,
                daysOfWeek: useDays,
                timeOfDay: !touched.when ? (spec?.timeOfDay || null) : null,
                // An agent brings its own model, so the tier is only meaningful
                // for agent-less work (the server ignores it otherwise).
                modelTier: useAgent ? 'auto' : modelTier,
                agentId: useAgent,
                enabledApps,
            });
            if (!payload) { setError(t('cowork.error.pick_moment', 'Pick a date and time first.')); return null; }

            const created = await createCowork(payload);
            reset();
            if (onCreated) onCreated(created, payload, spec);
            return created;
        } catch (err) {
            setError(messageOf(err, t('cowork.error.create_failed', 'Could not create this work')));
            return null;
        } finally {
            setSubmitting(false);
        }
    }, [when, repeatInterval, agentId, enabledApps, touched, submitting, reset, onCreated, t]);

    return {
        when, setWhen,
        repeatInterval, setRepeatInterval,
        agentId, setAgentId,
        enabledApps, setEnabledApps,
        agents,
        touched,
        submitting, error, setError,
        scheduleReady,
        summary: describeSchedule({ presetId: when.presetId, runAt: resolveWhen(when.presetId, when), repeatInterval }),
        submit, reset,
    };
}
