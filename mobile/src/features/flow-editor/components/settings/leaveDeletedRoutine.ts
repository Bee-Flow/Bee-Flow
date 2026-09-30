/**
 * Where a person lands after deleting the routine they are in. Its screens
 * (the routine, its build screen, a step, a flowlet, runs, versions, these
 * settings) sit on top of wherever it was opened from: the Automations list,
 * the Runs log, the Cowork hub, a Solution, a notification. All of them show
 * a routine that no longer exists, so all go — and only those: the person
 * comes back to where they came from. `dismissTo('/automations')` replaced
 * the screen with the list when the list was not underneath, and left the
 * deleted routine one Back away.
 *
 * Nothing underneath (a cold start from a notification) falls back to the
 * Automations list, replacing the last deleted screen.
 */

import type { Href } from 'expo-router';

/** One entry of the root Stack, as `navigation.getState().routes` lists it. */
export interface StackEntry {
    name: string;
    params?: object;
}

function showsRoutine(entry: StackEntry, automationId: string): boolean {
    const id = (entry.params as { id?: unknown } | undefined)?.id;
    return entry.name.startsWith('automations/[id]') && id === automationId;
}

/** How many screens, counted down from the top of the stack, belong to the routine. */
export function deletedRoutineDepth(routes: readonly StackEntry[], automationId: string): number {
    let depth = 0;
    for (let i = routes.length - 1; i >= 0 && showsRoutine(routes[i] as StackEntry, automationId); i--) depth += 1;
    return depth;
}

export interface LeaveRouter {
    dismiss: (count?: number) => void;
    replace: (href: Href) => void;
}

export function leaveDeletedRoutine(router: LeaveRouter, routes: readonly StackEntry[], automationId: string): void {
    const depth = Math.max(1, deletedRoutineDepth(routes, automationId));
    if (routes.length > depth) {
        router.dismiss(depth);
        return;
    }
    if (depth > 1) router.dismiss(depth - 1);
    router.replace('/automations');
}
