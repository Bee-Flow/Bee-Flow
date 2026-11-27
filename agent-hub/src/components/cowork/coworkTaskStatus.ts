/**
 * The one status vocabulary of a task, everywhere it is shown (the home's rows, the task's header, its runs):
 *
 *   Done · Failed · Needs you · Scheduled · Running · Testing · Paused · Nothing to do
 *
 * One function decides it, from the task and the cards that wait for its owner (./coworkNeedsModel.ts). In order:
 *
 *   Testing      Cowork is setting up and trying its steps right now (the home's progress, or a try-out);
 *   Running      a run is on the go (its last status, or a run row that is still open);
 *   Failed       a card that says something is wrong (a fix, a repair, a sign-in), a sign-in that ran out, or a
 *                last run that failed. Before Paused: the server pauses a task by itself when an app needs a
 *                sign-in again or a budget is reached, and that is not a pause its owner chose;
 *   Paused       switched off by its owner while it would start by itself;
 *   Needs you    a card that asks something (approve the steps, choose after a set-up that did not work, a message
 *                to send, a review, ...), a run that waits for a decision, or a task that waits for its steps before it
 *                runs at all;
 *   Nothing to do  the last run checked and found nothing to do (its outcome, server core/cowork/runOutcome.mts);
 *   Done         the last run went well;
 *   Scheduled    it has not run yet and waits for its start.
 *
 * One word per state: a task that failed says Failed and nothing beside it, and the server gives every failed task a
 * card under Needs you (usecases/coworkNeedsYou.mts), so the home and the task always agree.
 */
import { BLOCKS, waitsForSteps, type NeedCardData } from './coworkNeedsModel';
import type { CoworkItem } from '@/api/cowork.types';
import type { TranslateFn } from '@/hooks/useTranslation';

export type TaskStatus = 'done' | 'failed' | 'needs' | 'scheduled' | 'running' | 'testing' | 'paused' | 'nothing';

type StatusItem = Pick<CoworkItem, 'id' | 'isActive' | 'lastStatus' | 'lastRunAt' | 'runCount' | 'currentRunStartedAt' | 'repeatInterval' | 'daysOfWeek' | 'triggerKind' | 'setup' | 'planId'>;

export interface TaskStatusFacts {
    /** Cowork is setting up or trying its steps now. */
    testing?: boolean;
    /** The outcome code of its newest finished run (GET /api/cowork/home `outcomes`). */
    outcome?: string | null;
}

const FAILED_RUN = new Set(['error', 'failed', 'needs_reauth', 'incomplete', 'timeout', 'cancelled']);
const WAITING_RUN = new Set(['needs_review', 'waiting', 'awaiting_approval']);

/** It starts by itself: on a clock that repeats, or on an event (a mail, another task, a call). */
function startsByItself(item: StatusItem): boolean {
    if (item.repeatInterval || (Array.isArray(item.daysOfWeek) && item.daysOfWeek.length > 0)) return true;
    return !!item.triggerKind && item.triggerKind !== 'schedule';
}

/** The strongest thing that waits for this task: a problem over a question; null when nothing waits. */
type StatusCard = Pick<NeedCardData, 'itemId' | 'kind' | 'connection'>;
function blockOf(itemId: string, cards: readonly StatusCard[]): 'failed' | 'needs' | 'paused' | null {
    let found: 'failed' | 'needs' | 'paused' | null = null;
    for (const card of cards) {
        if (card.itemId !== itemId) continue;
        if (card.kind === 'sign_in' && card.connection?.canResume) {
            found ??= 'paused';
            continue;
        }
        if (BLOCKS[card.kind] === 'failed') return 'failed';
        found = 'needs';
    }
    return found;
}

/** Where the task's own last run leaves it, when nothing else decides. */
function fromLastRun(item: StatusItem, outcome: string | null | undefined): TaskStatus {
    if (!item.lastRunAt && !item.runCount) return 'scheduled';
    if (item.lastStatus === 'success') return outcome === 'nothing_to_do' ? 'nothing' : 'done';
    return 'scheduled';
}

export function taskStatus(item: StatusItem, cards: readonly StatusCard[] = [], facts: TaskStatusFacts = {}): TaskStatus {
    if (facts.testing) return 'testing';
    if (item.lastStatus === 'running' || item.currentRunStartedAt) return 'running';
    const block = blockOf(item.id, cards);
    if (block === 'paused' || block === 'failed') return block;
    const lastStatus = item.lastStatus ?? '';
    if (FAILED_RUN.has(lastStatus)) return 'failed';
    if (item.isActive === false && startsByItself(item)) return 'paused';
    if (block === 'needs' || WAITING_RUN.has(lastStatus) || waitsForSteps(item)) return 'needs';
    return fromLastRun(item, facts.outcome);
}

const WORDS: Readonly<Record<TaskStatus, readonly [string, string]>> = {
    done: ['cowork_home.status.done', 'Done'],
    failed: ['cowork_home.status.failed', 'Failed'],
    needs: ['cowork_home.status.needs', 'Needs you'],
    scheduled: ['cowork_home.status.scheduled', 'Scheduled'],
    running: ['cowork_home.status.running', 'Running'],
    testing: ['cowork_home.status.testing', 'Testing'],
    paused: ['cowork_home.status.paused', 'Paused'],
    nothing: ['cowork_home.status.nothing', 'Nothing to do'],
};

/** The status in words. */
export function taskStatusLabel(status: TaskStatus, t: TranslateFn): string {
    const [key, en] = WORDS[status];
    return t(key, en);
}
