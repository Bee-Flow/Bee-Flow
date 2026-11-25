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
 *
 * With `confirm`, nothing is created on send: what was worked out waits as a
 * `draft`, shown as one plain card (./CoworkConfirmCard.tsx). `start()`
 * creates it, or what the card made of it (the Cowork home's card hands in the
 * draft with its owner's own choices: the name, the day, the apps, who it
 * sends to); `change()` puts it back into the chips to adjust, and the next
 * send keeps what the card showed unless a chip is changed. A send while a
 * draft waits reads the sentence again and replaces the draft.
 */
import { useCallback, useState } from 'react';
import { useCoworkAgents } from '@/api/queries/coworkReads';
import { composeCowork, createCowork } from '../../api/coworkApi';
import type { CoworkRequestError } from '../../api/coworkApi';
import { isMailTriggerReady, normaliseMailTrigger, describeMailTrigger } from './mailTrigger';
import {
    buildCoworkPayload, titleFromBrief, describeSchedule, resolveWhen,
    nextOccurrence, toDateInput, toTimeInput,
} from './coworkSchedule';
import useTranslation from '../../hooks/useTranslation';
import { useEntitlements } from '../licensing/EntitlementsContext';
import type {
    CoworkAgent, CoworkItem, CoworkPayload, CoworkSpec, CoworkTriggerPayload, MailTrigger, WhenState,
} from '../../api/cowork.types';
import { messageOf } from '../../utils/caughtError';

export interface UseCoworkComposerOptions {
    enabled?: boolean;
    /** Start set to run every week on this weekday (0 Sunday … 6 Saturday), at 09:00: "You ask this every Monday". */
    weeklyOn?: number | null;
    onCreated?: (created: CoworkItem, payload: CoworkPayload | CoworkTriggerPayload, spec: CoworkSpec | null) => void;
    /** Show what was worked out for one confirmation (Start or Change) before anything is created. */
    confirm?: boolean;
}

/** A cowork worked out from a brief that waits for its one confirmation. */
export interface CoworkDraft {
    payload: CoworkPayload | CoworkTriggerPayload;
    spec: CoworkSpec | null;
}

/** The days and time a draft carried that the chips cannot show; kept for the next send until a chip changes. */
type Carried = Pick<CoworkPayload, 'daysOfWeek' | 'timeOfDay'> | null;

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
    /** Non-null while the item starts on a new email; it replaces the when/repeat pair. */
    mailTrigger: MailTrigger | null;
    setMailTrigger: (value: MailTrigger | null) => void;
    agents: CoworkAgent[];
    touched: Touched;
    submitting: boolean;
    error: string | null;
    setError: (value: string | null) => void;
    scheduleReady: boolean;
    summary: string;
    submit: (brief: string, opts?: { modelTier?: string }) => Promise<CoworkItem | null>;
    reset: () => void;
    /** With `confirm`: what waits for Start or Change; null otherwise. */
    draft: CoworkDraft | null;
    /** Create the draft, or `payload`: the draft as its card changed it. */
    start: (payload?: CoworkPayload | CoworkTriggerPayload) => Promise<CoworkItem | null>;
    /** Put the draft back into the chips to adjust it, and close the card. */
    change: () => void;
}

const DEFAULT_WHEN: WhenState = { presetId: 'now', date: '', time: '' };
const WEEK_TOKENS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

/** The first run of "every week on this day": the next such day at 09:00. Null for no weekday. */
function weeklyStart(weekday: number | null | undefined): WhenState | null {
    const token = typeof weekday === 'number' ? WEEK_TOKENS[weekday] : undefined;
    const first = token ? nextOccurrence('09:00', [token]) : null;
    return first ? { presetId: 'custom', date: toDateInput(first), time: toTimeInput(first) } : null;
}

const isTriggerPayload = (payload: CoworkPayload | CoworkTriggerPayload): payload is CoworkTriggerPayload => 'triggerKind' in payload && payload.triggerKind === 'app_event';

/** The when-chip of a draft's first run: now, or that moment. */
function whenOfDraft(payload: CoworkPayload | CoworkTriggerPayload): WhenState {
    if (!('nextRunAt' in payload) || payload.startNow) return DEFAULT_WHEN;
    const first = new Date(payload.nextRunAt);
    return Number.isNaN(first.getTime()) ? DEFAULT_WHEN : { presetId: 'custom', date: toDateInput(first), time: toTimeInput(first) };
}

/** What a create call refused, as the sentence under the box. */
function createError(err: unknown, t: ReturnType<typeof useTranslation>['t']): string {
    return (err as CoworkRequestError)?.code === 'mail_not_connected'
        ? t('cowork.mail_trigger.error_not_connected', 'That mail account is not connected. Connect it in Settings → Connections and try again.')
        : messageOf(err, t('cowork.error.create_failed', 'Could not create this work'));
}

export default function useCoworkComposer({ enabled = true, weeklyOn = null, onCreated, confirm = false }: UseCoworkComposerOptions = {}): UseCoworkComposerReturn {
    // The two errors this hook raises itself are shown in the composer, so they
    // are copy like any other. A server-sent `err.message` is NOT translated
    // here — it is the server's sentence, and inventing a key per message would
    // silently swallow the real reason.
    const { t } = useTranslation();
    // A weekday handed over (./coworkHandedBrief.ts) is a choice the person already made: it counts as touched.
    const [weekly] = useState(() => weeklyStart(weeklyOn));
    const [when, setWhenState] = useState<WhenState>(weekly ?? DEFAULT_WHEN);
    const [repeatInterval, setRepeatState] = useState(weekly ? 'weekly' : '');
    const [agentId, setAgentState] = useState('');
    // Which apps this one item may touch. null until the user opens the Apps
    // picker — that keeps "I didn't choose" (inherit the workspace-wide list)
    // distinct from "I chose nothing" (an empty array, a real answer).
    const [enabledApps, setEnabledApps] = useState<string[] | null>(null);
    const [mailTrigger, setMailTrigger] = useState<MailTrigger | null>(null);
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState<string | null>(null);
    // Which chips the user (or the surrounding chat) decided for themselves.
    const [touched, setTouched] = useState<Touched>({ when: !!weekly, repeat: !!weekly, agent: false });
    const [draft, setDraft] = useState<CoworkDraft | null>(null);
    const [carried, setCarried] = useState<Carried>(null);

    const ent = useEntitlements() as { loading: boolean; can: (id: string) => boolean };
    // Handing work to an agent is the same beta the server gates POST on — no
    // point offering the picker if the create call would 403.
    const canPickAgent = !!ent && !ent.loading && typeof ent.can === 'function' && ent.can('agent_routines');

    const agents = useCoworkAgents(enabled && canPickAgent);

    // Every setter the UI calls marks its chip as the user's choice. Seeding
    // the agent from an agent chat goes through setAgentId too, and that is
    // deliberate: if you are talking to an agent and delegate something, you
    // mean that agent — the composer must not reassign it.
    const setWhen = useCallback((value: WhenState) => {
        setWhenState(value);
        setCarried(null);
        setTouched(t => (t.when ? t : { ...t, when: true }));
    }, []);
    const setRepeatInterval = useCallback((value: string) => {
        setRepeatState(value);
        setCarried(null);
        setTouched(t => (t.repeat ? t : { ...t, repeat: true }));
    }, []);
    const setAgentId = useCallback((value: string) => {
        setAgentState(value);
        // A mail trigger is the agent's: without one there is nobody to answer the mail.
        if (!value) setMailTrigger(null);
        setTouched(t => (t.agent ? t : { ...t, agent: true }));
    }, []);

    const reset = useCallback(() => {
        setWhenState(DEFAULT_WHEN);
        setRepeatState('');
        setAgentState('');
        setEnabledApps(null);
        setMailTrigger(null);
        setTouched({ when: false, repeat: false, agent: false });
        setError(null);
        setDraft(null);
        setCarried(null);
    }, []);

    /** Create what was worked out, or (`held`) keep it for its one confirmation. */
    const finish = useCallback(async (payload: CoworkPayload | CoworkTriggerPayload, spec: CoworkSpec | null, held = confirm) => {
        if (held) {
            setDraft({ payload, spec });
            return null;
        }
        const created = await createCowork(payload);
        reset();
        if (onCreated) onCreated(created, payload, spec);
        return created;
    }, [confirm, reset, onCreated]);

    // 'custom' with empty inputs is the one unschedulable state — block send
    // rather than silently falling back to "now".
    const scheduleReady = mailTrigger
        ? !!agentId && isMailTriggerReady(mailTrigger)
        : !!resolveWhen(when.presetId, when);

    const submit = useCallback(async (brief: string, { modelTier }: { modelTier?: string } = {}) => {
        const text = String(brief || '').trim();
        if (!text || submitting) return null;

        setSubmitting(true);
        setError(null);
        try {
            if (mailTrigger) {
                // The brief IS the task for each mail: no composing, no clock.
                const payload: CoworkTriggerPayload = {
                    title: titleFromBrief(text),
                    prompt: text,
                    repeatInterval: null,
                    modelTier: agentId ? 'auto' : modelTier || 'auto',
                    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
                    agentId,
                    triggerKind: 'app_event',
                    trigger: normaliseMailTrigger(mailTrigger),
                    ...(Array.isArray(enabledApps) ? { enabledApps } : {}),
                };
                return await finish(payload, null);
            }
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
            const useDays = carried?.daysOfWeek ?? (touched.when ? null : (spec?.daysOfWeek || null));

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
                timeOfDay: carried?.timeOfDay ?? (!touched.when ? (spec?.timeOfDay || null) : null),
                // An agent brings its own model, so the tier is only meaningful
                // for agent-less work (the server ignores it otherwise).
                modelTier: useAgent ? 'auto' : modelTier,
                agentId: useAgent,
                enabledApps,
            });
            if (!payload) { setError(t('cowork.error.pick_moment', 'Pick a date and time first.')); return null; }

            return await finish(payload, spec);
        } catch (err) {
            setError(createError(err, t));
            return null;
        } finally {
            setSubmitting(false);
        }
    }, [when, repeatInterval, agentId, enabledApps, mailTrigger, touched, submitting, carried, finish, t]);

    const start = useCallback(async (payload?: CoworkPayload | CoworkTriggerPayload) => {
        if (!draft || submitting) return null;
        setSubmitting(true);
        setError(null);
        try {
            return await finish(payload ?? draft.payload, draft.spec, false);
        } catch (err) {
            setError(createError(err, t));
            return null;
        } finally {
            setSubmitting(false);
        }
    }, [draft, submitting, finish, t]);

    // Back to the chips, holding what the card showed: the next send keeps it unless a chip is changed.
    const change = useCallback(() => {
        if (!draft) return;
        const { payload } = draft;
        const clock = !isTriggerPayload(payload);
        if (clock) {
            setWhenState(whenOfDraft(payload));
            setRepeatState(payload.repeatInterval || '');
            setCarried(payload.daysOfWeek || payload.timeOfDay ? { daysOfWeek: payload.daysOfWeek, timeOfDay: payload.timeOfDay } : null);
        }
        if (payload.agentId) setAgentState(payload.agentId);
        setTouched((was) => ({ when: was.when || clock, repeat: was.repeat || clock, agent: was.agent || !!payload.agentId }));
        setError(null);
        setDraft(null);
    }, [draft]);

    return {
        when, setWhen,
        repeatInterval, setRepeatInterval,
        agentId, setAgentId,
        enabledApps, setEnabledApps,
        mailTrigger, setMailTrigger,
        agents,
        touched,
        submitting, error, setError,
        scheduleReady,
        summary: mailTrigger ? describeMailTrigger(mailTrigger, t) : describeSchedule({ presetId: when.presetId, runAt: resolveWhen(when.presetId, when), repeatInterval }),
        submit, reset,
        draft, start, change,
    };
}
