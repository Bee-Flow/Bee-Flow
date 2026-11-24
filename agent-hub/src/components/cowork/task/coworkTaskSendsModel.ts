/**
 * "Sends to" of a task as data (./TaskSetSendsTo.tsx, ./CoworkTaskSettings.tsx): who receives what it sends, in words,
 * and the ONE "Ask me" choice, which is the task's level of independence (server usecases/coworkIndependence.mts):
 *
 *   Ask me before every change or message   asks_everything
 *   Show me each message first              asks_before_sending
 *   Don't ask                               on_its_own
 *
 * Who it sends to is read from its steps where it has fixed steps (the plan's `recipients`, server
 * core/cowork/planTrust.mts sendsToOf, and what the plan may reach); a task a mail starts drafts its reply to the
 * sender; any other task tells only its owner. Pure: no fetching, no React.
 */
import { isMailTriggerItem } from '../mailTrigger';
import type { Independence, IndependenceState } from '@/api/coworkIndependence';
import type { PlanState } from '@/api/coworkPlan.types';
import type { CoworkItem } from '@/api/cowork.types';
import type { TranslateFn } from '@/hooks/useTranslation';
import type { TaskMode } from './coworkTaskModel';

/** The recipient of a result for the owner, and of a step whose addresses the plan picks from data. */
const OWNER = 'owner';
const ANY = '*';

export const ASK_LEVELS: readonly Independence[] = ['asks_everything', 'asks_before_sending', 'on_its_own'];

const ASK_WORDS: Readonly<Record<Independence, [string, string]>> = {
    asks_everything: ['cowork_task.ask.everything', 'Ask me before every change or message'],
    asks_before_sending: ['cowork_task.ask.sending', 'Show me each message first'],
    on_its_own: ['cowork_task.ask.none', "Don't ask"],
};

export const askLabel = (level: Independence, t: TranslateFn): string => t(...ASK_WORDS[level]);

/** The level that holds now: the owner's choice, else what the next run uses; null while the server has not said. */
export function askLevelOf(state: IndependenceState | undefined): Independence | null {
    const level = state?.chosen ?? state?.level ?? null;
    return level && ASK_LEVELS.includes(level) ? level : null;
}

/** Who one sending step reaches, in words: "you", "sam@hoekstra.example", "the addresses it picks". */
export function recipientWord(recipient: string | null | undefined, t: TranslateFn): string | null {
    if (!recipient) return null;
    if (recipient === OWNER) return t('cowork_task.sends.you_lower', 'you');
    if (recipient === ANY) return t('cowork_task.send.anyone', 'the addresses it picks');
    return recipient.split(',').join(', ');
}

export interface SendsFacts {
    item: Pick<CoworkItem, 'triggerKind' | 'trigger'>;
    mode: TaskMode;
    plan: PlanState | null | undefined;
}

/** The plan's permissions that count: the approved ones, else those of the steps on screen. */
const permissionsOf = (plan: PlanState | null | undefined) => plan?.approved?.permissions ?? plan?.draft?.permissions ?? null;

/** It can reach other people: only then is there a message of someone else's to show first. */
export function reachesOthers({ mode, plan }: SendsFacts): boolean {
    return mode === 'steps' && permissionsOf(plan)?.sends === 'others';
}

/** Everyone the fixed steps send to, each once, the owner first. */
function planRecipients(plan: PlanState | null | undefined, t: TranslateFn): string[] {
    const sends = permissionsOf(plan)?.sends ?? null;
    const named = Object.values(plan?.draft?.recipients ?? {});
    const words: string[] = [];
    const add = (word: string) => { if (!words.includes(word)) words.push(word); };
    if (sends === 'owner' || named.includes(OWNER)) add(t('cowork_task.sends.you', 'You'));
    for (const recipient of named) {
        if (recipient === OWNER) continue;
        if (recipient === ANY) add(t('cowork_task.sends.anyone', 'The addresses it picks'));
        else recipient.split(',').forEach(add);
    }
    if (words.length === 0 && sends === 'others') add(t('cowork_task.sends.others', 'Other people'));
    return words;
}

/** Who receives what the task sends, in words; empty for steps that send nothing. */
export function recipientsOf(facts: SendsFacts, t: TranslateFn): string[] {
    const { item, mode, plan } = facts;
    if (isMailTriggerItem({ triggerKind: item.triggerKind ?? null, trigger: item.trigger })) return [t('cowork_task.sends.sender', 'The sender of the mail, as a draft for you to send')];
    if (mode === 'steps' && plan?.draft) return planRecipients(plan, t);
    return [t('cowork_task.sends.you', 'You')];
}

/** The Sends to row while closed: "You, sam@hoekstra.example", or that it sends nothing. */
export function sendsValue(facts: SendsFacts, t: TranslateFn): string {
    const list = recipientsOf(facts, t);
    return list.length > 0 ? list.join(', ') : t('cowork_task.sends.nobody', 'Nobody: it sends nothing');
}

/** Under it: the Ask me choice that holds, or why there is none yet. */
export function askNote(level: Independence | null, hasApprovedSteps: boolean, t: TranslateFn): string {
    if (!hasApprovedSteps) return t('cowork_task.ask.not_yet_short', 'Asking first starts once its steps are approved');
    return level ? askLabel(level, t) : '';
}
