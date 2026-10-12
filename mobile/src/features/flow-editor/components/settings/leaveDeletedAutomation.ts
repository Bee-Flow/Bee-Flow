/**
 * Where a person lands after deleting the automation they are in. Its screens
 * (the automation, its build screen, a step, a flowlet, runs, versions, these
 * settings) sit on top of wherever it was opened from: the Automations list,
 * the Runs log, the Cowork hub, a Solution, a notification. All of them show
 * an automation that no longer exists, so all go — and only those: the person
 * comes back to where they came from. `dismissTo('/automations')` replaced
 * the screen with the list when the list was not underneath, and left the
 * deleted automation one Back away.
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

function showsAutomation(entry: StackEntry, automationId: string): boolean {
    const id = (entry.params as { id?: unknown } | undefined)?.id;
    return entry.name.startsWith('automations/[id]') && id === automationId;
}

/** How many screens, counted down from the top of the stack, belong to the automation. */
export function deletedAutomationDepth(routes: readonly StackEntry[], automationId: string): number {
    let depth = 0;
    for (let i = routes.length - 1; i >= 0 && showsAutomation(routes[i] as StackEntry, automationId); i--) depth += 1;
    return depth;
}

export interface LeaveRouter {
    dismiss: (count?: number) => void;
    replace: (href: Href) => void;
}

export function leaveDeletedAutomation(router: LeaveRouter, routes: readonly StackEntry[], automationId: string): void {
    const depth = Math.max(1, deletedAutomationDepth(routes, automationId));
    if (routes.length > depth) {
        router.dismiss(depth);
        return;
    }
    if (depth > 1) router.dismiss(depth - 1);
    router.replace('/automations');
}
