/**
 * Who a Cowork plan run's questions go to (./plan/planIndependence.mts withAsks), decided as the run starts:
 *
 *   - the item is on a desk and its owner chose a role for its questions (stores/coworkDesks.mts `desk_role`): the
 *     holder of that role, or its stand-in while the holder is away (`away_until` in the future). A question the
 *     holder does not answer within one working day moves to the stand-in (the engine's escalation,
 *     core/automationRunner/approvalRouting.mts), and the question says so;
 *   - else the colleague the owner shared the item with to decide its questions (stores/coworkShares.mts);
 *   - else nobody: the owner decides.
 *
 * A working day is kept simple: 24 hours, skipping Saturdays and Sundays (in UTC), so a question asked on a Friday
 * morning moves on Monday morning. Public holidays and working hours are not known here.
 *
 * Holders and stand-ins count only while they are active members of the desk's organisation (the store reads them
 * that way). Who may decide is asked again at the decision (./planQuestionDecider.mts deskDecidersOf): a former holder
 * no longer decides, though the approval row may still name them.
 */

import { createRequire } from 'node:module';
import type { QuestionRoute } from './plan/planIndependence.mts';
import type { QuestionRole } from '../../stores/coworkDesks.mts';

const nodeRequire = createRequire(import.meta.url);

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

/** Hours until one working day from `now` has passed: 24, or more over a weekend. */
export function workingDayHours(now: Date): number {
    let at = now.getTime() + DAY_MS;
    while ([0, 6].includes(new Date(at).getUTCDay())) at += DAY_MS;
    return Math.round((at - now.getTime()) / HOUR_MS);
}

/** The route of a question for a desk role, or null when the role has nobody who counts. */
export function routeForRole(role: QuestionRole, now: Date): QuestionRoute | null {
    const away = !!role.awayUntil && Date.parse(role.awayUntil) > now.getTime();
    const holder = away ? null : role.holderId;
    const standIn = role.standInId && role.standInId !== holder ? role.standInId : null;
    if (holder && standIn) {
        return {
            userId: holder, escalateTo: standIn, escalateAfterHours: workingDayHours(now),
            note: `It is asked of whoever holds "${role.role}" on the desk. If it is not answered within a working day, it moves to their stand-in.`,
        };
    }
    if (holder) return { userId: holder, note: `It is asked of whoever holds "${role.role}" on the desk.` };
    if (!standIn) return null;
    const why = away ? `The holder of "${role.role}" is away until ${new Date(String(role.awayUntil)).toISOString().slice(0, 10)}` : `"${role.role}" has no holder now`;
    return { userId: standIn, note: `${why}, so this question went to their stand-in.` };
}

export interface DeskQuestionDeps {
    questionRoleOf: (scheduleId: string) => Promise<QuestionRole | null>;
    approverOf: (scheduleId: string) => Promise<string | null>;
    now: () => Date;
}

const defaults = (): DeskQuestionDeps => ({
    questionRoleOf: (id) => (nodeRequire('../../stores/coworkDesks.mts') as typeof import('../../stores/coworkDesks.mts')).coworkDesks().questionRoleOf(id),
    approverOf: (id) => (nodeRequire('../../stores/coworkShares.mts') as typeof import('../../stores/coworkShares.mts')).coworkShares().approverOf(id),
    now: () => new Date(),
});

/** Where the item's questions go now; null: to its owner. */
export async function questionRouteOf(scheduleId: string, deps: DeskQuestionDeps = defaults()): Promise<QuestionRoute | null> {
    if (!scheduleId) return null;
    const role = await deps.questionRoleOf(scheduleId);
    const byRole = role ? routeForRole(role, deps.now()) : null;
    if (byRole) return byRole;
    const approver = await deps.approverOf(scheduleId);
    return approver ? { userId: approver } : null;
}

/** The people who decide the item's questions by its desk role now: the holder and the stand-in. */
export async function deskDecidersOf(scheduleId: string, deps: Pick<DeskQuestionDeps, 'questionRoleOf'> = defaults()): Promise<string[]> {
    const role = await deps.questionRoleOf(scheduleId);
    return role ? [role.holderId, role.standInId].filter((id): id is string => !!id) : [];
}
