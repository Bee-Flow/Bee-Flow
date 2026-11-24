/**
 * The one plain sentence that says what a cowork does and when (./CoworkOverview.tsx, and the card that confirms a new
 * one, ./CoworkConfirmCard.tsx): "Every weekday 16:30, the AI works on: “Answer the new supplier mails.” Nothing is
 * sent without you." Built from the item itself (how it starts, its brief or its plan) and, for a plan, from what the
 * approved plan may send and how independent it is. Pure.
 *
 * It only says what holds: "Nothing is sent without you" is said of a plan whose level asks before sending, never of
 * a prompt the AI runs on its own; that one says nothing about sending.
 */
import { cadenceLine, describeMoment } from './coworkSchedule';
import { isMailTriggerItem, mailProviderLabel } from './mailTrigger';
import type { Independence } from '@/api/coworkIndependence';
import type { PlanPermissions, PlanStepKind } from '@/api/coworkPlan.types';
import type { CoworkItem } from '@/api/cowork.types';
import type { TranslateFn } from '@/hooks/useTranslation';

type ItemFacts = Pick<CoworkItem, 'title' | 'prompt' | 'isActive' | 'repeatInterval' | 'daysOfWeek' | 'timeOfDay' | 'nextRunAt' | 'lastStatus' | 'enabledApps' | 'trigger'>
    & { triggerKind?: string | null };

export interface OverviewFacts {
    item: ItemFacts;
    /** The item's plan: how many steps, and whether one was approved. Null: it has no plan (the AI does it each time). */
    plan: { steps: number; approved: boolean } | null;
    /** Who the approved plan can reach (its permissions); null when unknown or no plan. */
    sends: PlanPermissions['sends'] | null;
    /** How independent the approved plan runs; null when unknown or no plan. */
    level: Independence | null;
    /** The agent it runs as, when it has one. */
    agentName: string | null;
    /** A new cowork whose first run is right away (the compose card). */
    startsNow?: boolean;
}

const BRIEF_MAX = 110;

/** The first sentence of the brief, cut at a word when it is long. */
export function briefLine(prompt: string | null | undefined): string {
    const text = String(prompt ?? '').replace(/\s+/g, ' ').trim();
    const end = text.search(/[.!?](\s|$)/);
    const first = end > 0 ? text.slice(0, end + 1) : text;
    if (first.length <= BRIEF_MAX) return first;
    const cut = first.slice(0, BRIEF_MAX);
    return `${cut.slice(0, Math.max(cut.lastIndexOf(' '), BRIEF_MAX / 2)).trimEnd()}…`;
}

const isRecurring = (item: ItemFacts): boolean => !!item.repeatInterval || (Array.isArray(item.daysOfWeek) && item.daysOfWeek.length > 0);

/** What starts it, for a start that is not the clock; null for the clock. */
function eventWhen(item: ItemFacts, t: TranslateFn): string | null {
    if (isMailTriggerItem({ triggerKind: item.triggerKind ?? null, trigger: item.trigger })) {
        return t('cowork_overview.when.mail', 'When a new e-mail arrives in {app}', { app: mailProviderLabel(item.trigger?.provider ?? '', t) });
    }
    switch (item.triggerKind) {
        case 'after_cowork': return t('cowork_overview.when.after', 'When the cowork it follows is done');
        case 'webhook': return t('cowork_overview.when.webhook', 'When another app calls it');
        case 'row': return t('cowork_overview.when.row', 'When a row is added to its table');
        case 'file': return t('cowork_overview.when.file', 'When a file arrives in its folder');
        default: return null;
    }
}

/** "Every weekday 16:30", "When a new e-mail arrives in Outlook", "Once, Dec 1 at 06:30", "Right away". */
export function whenPart(facts: Pick<OverviewFacts, 'item' | 'startsNow'>, t: TranslateFn): string {
    const { item } = facts;
    const event = eventWhen(item, t);
    if (event) return event;
    if (isRecurring(item)) return cadenceLine(item, t);
    if (facts.startsNow) return t('cowork_overview.when.now', 'Right away');
    if (item.nextRunAt && item.isActive !== false) return t('cowork_overview.when.once_at', 'Once, {when}', { when: describeMoment(item.nextRunAt) });
    return t('cowork_overview.when.once', 'Once');
}

/** When a task runs, in a few words, for a line of its own: the home's rows and the card that confirms a new one. */
export function whenLine(item: ItemFacts, t: TranslateFn, startsNow = false): string {
    return whenPart({ item, plan: null, sends: null, level: null, agentName: null, startsNow }, t);
}

/** "it follows its approved plan of 6 steps", "the AI works on: “…”". */
function whatPart({ item, plan, agentName }: OverviewFacts, t: TranslateFn): string {
    if (plan?.approved) {
        return plan.steps === 1
            ? t('cowork_overview.what.plan_one', 'it follows its approved plan of one step')
            : t('cowork_overview.what.plan', 'it follows its approved plan of {count} steps', { count: plan.steps });
    }
    if (plan) return t('cowork_overview.what.plan_waiting', 'it will follow a fixed plan');
    // The sentence ends with its own full stop, so the quoted brief does not bring one.
    const brief = (briefLine(item.prompt) || item.title).replace(/[.!?]+$/, '');
    return agentName
        ? t('cowork_overview.what.agent', '{agent} works on: “{brief}”', { agent: agentName, brief })
        : t('cowork_overview.what.ai', 'the AI works on: “{brief}”', { brief });
}

/** What holds about sending, as far as it can be said truthfully: a prompt the AI runs gets no promise about sending. */
function holdsPart({ item, plan, sends, level }: OverviewFacts, t: TranslateFn): string {
    if (plan && !plan.approved) return t('cowork_overview.holds.plan_waiting', 'Its plan waits for your approval.');
    if (plan) {
        if (sends === 'none') return t('cowork_overview.holds.sends_none', 'It sends nothing to anyone.');
        if (sends === 'owner') return t('cowork_overview.holds.sends_owner', 'It only reports to you.');
        if (level === 'asks_everything') return t('cowork_overview.holds.asks_everything', 'It asks you before it changes or sends anything.');
        if (level === 'on_its_own') return t('cowork_overview.holds.on_its_own', 'It sends on its own, as you approved.');
        return t('cowork_overview.holds.asks_before_sending', 'Nothing is sent without you.');
    }
    if (Array.isArray(item.enabledApps) && item.enabledApps.length === 0) return t('cowork_overview.holds.answer_only', 'It only writes an answer for you.');
    return t('cowork_overview.holds.reports', 'It reports to you after each run.');
}

/** Stopped for now: switched off by its owner, or waiting for a sign-in. Null while it runs as set. */
function stoppedPart(facts: OverviewFacts, t: TranslateFn): string | null {
    const { item } = facts;
    if (item.lastStatus === 'needs_reauth') return t('cowork_overview.needs_sign_in', 'It stopped: an app needs you to sign in again.');
    const startsByItself = isRecurring(item) || !!eventWhen(item, t);
    if (item.isActive === false && startsByItself) return t('cowork_overview.paused', 'Paused: nothing runs until you resume it.');
    return null;
}

/** The sentence, in plain words. */
export function overviewSentence(facts: OverviewFacts, t: TranslateFn): string {
    const main = t('cowork_overview.sentence', '{when}, {what}.', { when: whenPart(facts, t), what: whatPart(facts, t) });
    return [stoppedPart(facts, t), main, holdsPart(facts, t)].filter(Boolean).join(' ');
}

const KIND_FALLBACK: Record<PlanStepKind, string> = { fixed: 'A fixed step', ai: 'An AI step', ask: 'A question for you', deliver: 'A result for you' };

/**
 * A step's title as a person reads it: its own title; words instead of a tool name ("outlook_create_draft" → "Outlook
 * create draft"); and the kind of step when the title is only an id.
 */
export function plainStepTitle(step: { id: string; title: string; kind: PlanStepKind }, t: TranslateFn): string {
    const title = String(step.title ?? '').trim();
    if (!title || title === step.id || /^[a-z]{1,3}_[0-9a-f]{4,}$/i.test(title)) return t(`cowork_overview.step.${step.kind}`, KIND_FALLBACK[step.kind] ?? KIND_FALLBACK.fixed);
    if (/^[a-z0-9]+(?:_[a-z0-9]+)+$/.test(title)) {
        const words = title.replaceAll('_', ' ');
        return words.charAt(0).toUpperCase() + words.slice(1);
    }
    return title;
}
