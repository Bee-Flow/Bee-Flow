/**
 * What waits for the owner, as the cards of ./CoworkNeedCard.tsx: one shape for every kind, built from what the server
 * already says. Two sources:
 *
 *   - "Needs you" (GET /api/cowork/needs-you, server/usecases/coworkNeedsYou.mts): a plan to check, test or fix, a
 *     set-up that did not work, a run that failed or did not do its work, a repair, a sign-in, a decision before
 *     something is sent, a review;
 *   - the desks the owner is on (GET /api/cowork/desks/:id): an invitation of one of their tasks to a desk, and a
 *     colleague's task that asks to get the result of one of theirs (a hand-off).
 *
 * Every card belongs to one of the owner's tasks (`itemId`), and makes the task's status Failed or Needs you
 * (./coworkTaskStatus.ts reads `BLOCKS`).
 */
import type { CoworkItem, CoworkSetupCause } from '@/api/cowork.types';
import type { DeskView } from '@/api/coworkDesks';
import type { CoworkFailureCause, CoworkNeed } from '@/api/coworkNeedsYou';

export type NeedCardKind = 'check' | 'first_test' | 'fix' | 'setup' | 'repair' | 'sign_in' | 'send' | 'review' | 'hand_off' | 'invitation';

/**
 * Why a "fix" card is there. About the steps: their order (Cowork fixes it), steps that cannot run or are gone, a test
 * that failed. About the last run: an app that is no longer allowed (`permission`), a sign-in that ran out, a step
 * that could not read from another (`reads`) or just did not work (`step`), a list that never arrived (`incomplete`),
 * the AI's own verdict, a run that took too long, or one that failed and nothing more is known (`failed`).
 */
export type NeedProblem = 'wiring' | 'blocked' | 'gone' | 'tried_failed' | 'incomplete' | 'ai_failed'
    | 'permission' | 'signed_out' | 'reads' | 'step' | 'timeout' | 'failed';

/** What a failed run's sentence names: the step and the step it reads by their titles, the app by its name. */
export interface NeedWords { step: string | null; source: string | null; app: string | null }

export interface NeedCardData {
    /** Stable over reads, for a React key. */
    key: string;
    kind: NeedCardKind;
    /** The owner's task it is about. */
    itemId: string;
    /** That task's title. */
    title: string;
    /** A review or a decision: the run it is about. */
    runId?: string | null;
    /** A review: the agent's reason. */
    reason?: string | null;
    /** A check: the steps changed after an earlier approval (they may do more). */
    changed?: boolean;
    problem?: NeedProblem;
    /** A fix for a failed run: what its sentence names. */
    words?: NeedWords;
    /** A fix: the task has fixed steps, so "let the AI work it out every run" is a way out. */
    hasSteps?: boolean;
    /** A set-up that ended without steps: why, as a class. */
    cause?: CoworkSetupCause;
    /** A repair: the proposal and the step it is about. */
    repair?: { proposalId: string; reasonCode: string; stepTitle: string | null };
    /** A send: the automation whose approval waits. */
    automationId?: string | null;
    /** An invitation: the desk, and who invited. */
    desk?: { id: string; name: string; invitedBy: string };
    /** A hand-off: the colleague's task that asks for the result of this one. */
    handOff?: { deskId: string; followerId: string; followerTitle: string; ownerName: string };
    /** A check inside the task: the fingerprint of the steps on screen, which approving sends. */
    fingerprint?: string;
    /** A check: the task does not run for real until its steps are approved. */
    held?: boolean;
}

/**
 * The task waits for its owner before it runs at all: it was started to get fixed steps, and none is approved yet
 * (server core/cowork/taskSetup.mts heldForSetup). Nothing runs by itself, so no next run is promised.
 */
export function waitsForSteps(item: Pick<CoworkItem, 'setup' | 'planId'> | null | undefined): boolean {
    const steps = item?.setup?.steps;
    return (steps === 'wanted' || steps === 'failed') && !item?.planId;
}

/** Which status a card gives its task: a problem (Failed) or a question (Needs you). */
export const BLOCKS: Readonly<Record<NeedCardKind, 'failed' | 'needs'>> = {
    fix: 'failed', repair: 'failed', sign_in: 'failed',
    check: 'needs', first_test: 'needs', setup: 'needs', send: 'needs', review: 'needs', hand_off: 'needs', invitation: 'needs',
};

/** The problem a failed run's cause is, on its card. */
const PROBLEM_OF: Readonly<Record<CoworkFailureCause, NeedProblem>> = {
    permission: 'permission', sign_in: 'signed_out', reads: 'reads', nothing_found: 'incomplete', ai_failed: 'ai_failed',
    timeout: 'timeout', step: 'step', waits: 'failed', nothing_to_do: 'failed', other: 'failed',
};

/** A run that failed: the problem its cause is, with what its sentence names. */
function failedCard(need: CoworkNeed): Pick<NeedCardData, 'kind' | 'problem' | 'words' | 'hasSteps' | 'runId'> {
    const failure = need.failure;
    return {
        kind: 'fix', runId: need.runId, hasSteps: need.hasSteps === true,
        problem: failure ? PROBLEM_OF[failure.cause] ?? 'failed' : 'failed',
        words: { step: failure?.step ?? null, source: failure?.source ?? null, app: failure?.app ?? null },
    };
}

const keyOf = (need: CoworkNeed): string => `${need.kind}-${need.itemId}-${need.runId ?? need.repair?.proposalId ?? ''}`;

/** A plan that waits: tested (check it), never tested (test it once), or a test that failed or wiring to fix (fix it). */
function planCard(need: CoworkNeed, item: CoworkItem | undefined): Pick<NeedCardData, 'kind' | 'problem' | 'changed' | 'hasSteps' | 'held'> {
    if (need.plan === 'gone') return { kind: 'fix', problem: 'gone', hasSteps: true };
    if (need.plan === 'blocked') return { kind: 'fix', problem: need.fixable ? 'wiring' : 'blocked', hasSteps: true };
    if (need.tried === 'failed') return { kind: 'fix', problem: need.fixable ? 'wiring' : 'tried_failed', hasSteps: true };
    if (need.plan === 'changed') return { kind: 'check', changed: true };
    const neverRan = !!item && !item.lastRunAt && !item.runCount;
    if (need.tried !== 'passed' && need.tried !== 'running' && neverRan) return { kind: 'first_test' };
    return { kind: 'check', held: waitsForSteps(item) };
}

function cardOf(need: CoworkNeed, item: CoworkItem | undefined): NeedCardData {
    const base = { key: keyOf(need), itemId: need.itemId, title: need.title };
    switch (need.kind) {
        case 'decision': return { ...base, kind: 'send', runId: need.runId, automationId: item?.planAutomationId ?? null };
        case 'review': return { ...base, kind: 'review', runId: need.runId, reason: need.reason };
        case 'sign_in': return { ...base, kind: 'sign_in' };
        case 'repair': return need.repair ? { ...base, kind: 'repair', repair: need.repair } : { ...base, kind: 'fix', problem: 'blocked' };
        case 'incomplete':
        case 'ai_failed': return { ...base, kind: 'fix', problem: need.kind, runId: need.runId };
        case 'failed': return { ...base, ...failedCard(need) };
        case 'setup': return { ...base, kind: 'setup', cause: need.cause ?? 'failed' };
        default: return { ...base, ...planCard(need, item) };
    }
}

/** The cards of "Needs you", in the server's order (most urgent first). */
export function needCards(needs: readonly CoworkNeed[], items: readonly CoworkItem[]): NeedCardData[] {
    const byId = new Map(items.map((i) => [i.id, i]));
    return needs.map((need) => cardOf(need, byId.get(need.itemId)));
}

/** The desks' cards: invitations of the owner's tasks, and colleagues' tasks that ask for the result of one of theirs. */
export function deskNeedCards(views: readonly DeskView[]): NeedCardData[] {
    const out: NeedCardData[] = [];
    for (const view of views) {
        const { desk } = view;
        // A desk read that came back without its members (an older or a failed answer) adds nothing.
        const members = Array.isArray(view.members) ? view.members : [];
        if (!desk) continue;
        for (const m of members) {
            if (m.mine && !m.accepted) {
                out.push({ key: `invitation-${desk.id}-${m.scheduleId}`, kind: 'invitation', itemId: m.scheduleId, title: m.title, desk: { id: desk.id, name: desk.name, invitedBy: desk.ownerName } });
            }
            const leader = m.after ? members.find((l) => l.scheduleId === m.after) : undefined;
            if (m.decidesHandOff && m.handOff === 'waiting' && leader) {
                out.push({
                    key: `hand_off-${desk.id}-${m.scheduleId}`, kind: 'hand_off', itemId: leader.scheduleId, title: leader.title,
                    handOff: { deskId: desk.id, followerId: m.scheduleId, followerTitle: m.title, ownerName: m.ownerName },
                });
            }
        }
    }
    return out;
}
