/**
 * Switching "it notices what you repeat" on or off for oneself (routes/coworkHabitRoutes.js). Off by default; the
 * organisation may not allow it at all (core/entitlements/coworkPolicy.mts `habitsAllowed`), and then it cannot be
 * switched on. Switching it off forgets everything it noted.
 */

import { createRequire } from 'node:module';
import { HABITS_KEY } from '../core/cowork/habits/habitSignals.mts';
import { policyOfOwner, type CoworkPolicy } from '../core/entitlements/coworkPolicy.mts';

const nodeRequire = createRequire(import.meta.url);
const { HttpError } = nodeRequire('../core/http/errors.js') as { HttpError: new (status: number, code: string, message: string) => Error };

export interface HabitsDeps {
    getConfig: (key: string) => Promise<unknown>;
    setConfig: (key: string, value: unknown) => Promise<unknown>;
    policyOf: (userId: string) => Promise<CoworkPolicy>;
    forget: (userId: string) => Promise<void>;
}

const defaults = (): HabitsDeps => {
    const config = nodeRequire('../stores/configStore.js') as { getConfig: HabitsDeps['getConfig']; setConfig: HabitsDeps['setConfig'] };
    return {
        getConfig: (k) => config.getConfig(k),
        setConfig: (k, v) => config.setConfig(k, v),
        policyOf: (u) => policyOfOwner(u),
        forget: (u) => (nodeRequire('../stores/coworkHabits.mts') as typeof import('../stores/coworkHabits.mts')).coworkHabits().forget(u),
    };
};

export interface HabitsState { on: boolean; allowed: boolean }

export async function habitsOf(userId: string, deps: HabitsDeps = defaults()): Promise<HabitsState> {
    const allowed = (await deps.policyOf(userId)).habitsAllowed !== false;
    return { on: allowed && (await deps.getConfig(HABITS_KEY(userId))) === true, allowed };
}

export async function setHabits(userId: string, on: boolean, deps: HabitsDeps = defaults()): Promise<HabitsState> {
    const allowed = (await deps.policyOf(userId)).habitsAllowed !== false;
    if (on && !allowed) throw new HttpError(403, 'cowork_habits_refused', 'Your organisation does not let Cowork notice what people repeat.');
    await deps.setConfig(HABITS_KEY(userId), on);
    if (!on) await deps.forget(userId);
    return { on, allowed };
}
