/**
 * "It notices what you repeat" (Cowork 3.2): when a person asks the same kind of thing on the same weekday four weeks
 * in a row, the chat offers once to let Cowork do it. Per person, off until that person switches it on, and only where
 * the organisation allows it (core/entitlements/coworkPolicy.mts `habitsAllowed`).
 *
 * What counts as "the same kind of thing" is worked out without the words: the agent and the app tools the turn used,
 * hashed. Only a turn that used at least one app tool counts — a plain question has nothing Cowork could repeat. The
 * signal is stored (stores/coworkHabits.mts) with the weekday and the ISO week, never the question or the answer; the
 * brief of the cowork it offers is filled in the browser from the message on screen.
 *
 * Called by core/agentRuntime/finalizeTurn.js after a chat turn; never throws, never slows the turn down.
 */

import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import type { HabitSignal } from '../../../stores/coworkHabits.mts';

const nodeRequire = createRequire(import.meta.url);
const log = nodeRequire('../../../telemetry/log.js') as { warn: (m: string) => void };

export const WEEKS_IN_A_ROW = 4;
const KEEP_WEEKS = 8;
const WEEK_MS = 7 * 86_400_000;
export const HABITS_KEY = (userId: string): string => `cowork_habits_user_${userId}`;

export interface HabitDeps {
    /** Did this person switch it on, and does their organisation allow it? */
    enabled: (userId: string) => Promise<boolean>;
    appOf: (toolName: string) => string | null;
    store: {
        note: (userId: string, s: HabitSignal) => Promise<void>;
        weeksOf: (userId: string, toolsHash: string, weekday: number) => Promise<string[]>;
        claimOffer: (userId: string, toolsHash: string) => Promise<boolean>;
        prune: (userId: string, before: Date) => Promise<void>;
    };
}

const defaults = (): HabitDeps => {
    const config = nodeRequire('../../../stores/configStore.js') as { getConfig: (k: string) => Promise<unknown> };
    const { policyOfOwner } = nodeRequire('../../entitlements/coworkPolicy.mts') as typeof import('../../entitlements/coworkPolicy.mts');
    const { appIdForTool } = nodeRequire('../../agentRuntime/toolPolicy/appIndex.js') as { appIdForTool: (n: string) => string | null };
    return {
        enabled: async (userId) => (await config.getConfig(HABITS_KEY(userId))) === true && (await policyOfOwner(userId)).habitsAllowed !== false,
        appOf: (n) => appIdForTool(n),
        store: (nodeRequire('../../../stores/coworkHabits.mts') as typeof import('../../../stores/coworkHabits.mts')).coworkHabits(),
    };
};

/** The ISO week of a moment, "2026-W48", in UTC. */
export function isoWeekOf(at: Date): string {
    const d = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
    const day = d.getUTCDay() || 7;
    d.setUTCDate(d.getUTCDate() + 4 - day);
    const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
    const week = Math.ceil(((d.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
    return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

/** The kind of a turn: its agent and the app tools it used, hashed; null for a turn that used no app. */
export function kindOfTurn(agentId: string, toolNames: string[], appOf: HabitDeps['appOf']): string | null {
    const apps = [...new Set(toolNames.filter((n) => typeof n === 'string' && appOf(n) !== null))].sort();
    if (apps.length === 0) return null;
    return createHash('sha256').update(`${agentId}\u0000${apps.join('\u0000')}`).digest('hex');
}

/** Were these the last `n` weeks in a row, ending with `thisWeek`? */
export function inARow(weeks: string[], at: Date, n: number = WEEKS_IN_A_ROW): boolean {
    const have = new Set(weeks);
    for (let i = 0; i < n; i += 1) {
        if (!have.has(isoWeekOf(new Date(at.getTime() - i * WEEK_MS)))) return false;
    }
    return true;
}

export interface HabitOffer { weekday: number; weeks: number }

/** Note a chat turn; answers the one offer to make, or null. Never throws. */
export async function noteTurn(
    { userId, agentId, toolNames, at = new Date() }: { userId: string; agentId: string; toolNames: string[]; at?: Date },
    deps: HabitDeps = defaults(),
): Promise<HabitOffer | null> {
    try {
        const toolsHash = kindOfTurn(agentId, toolNames, deps.appOf);
        if (!toolsHash || !(await deps.enabled(userId))) return null;
        const weekday = at.getUTCDay();
        await deps.store.note(userId, { agentId, toolsHash, weekday, isoWeek: isoWeekOf(at) });
        await deps.store.prune(userId, new Date(at.getTime() - KEEP_WEEKS * WEEK_MS));
        if (!inARow(await deps.store.weeksOf(userId, toolsHash, weekday), at)) return null;
        return (await deps.store.claimOffer(userId, toolsHash)) ? { weekday, weeks: WEEKS_IN_A_ROW } : null;
    } catch (e) {
        log.warn(`[Cowork] a habit signal was not noted: ${(e as Error).message}`);
        return null;
    }
}
