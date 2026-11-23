/**
 * The automation a plan can be made from, and run on: one that exists, is an automation (not a building block),
 * belongs to the item's owner, and is not managed by a Solution stage.
 *
 * A managed automation is deployed by its Solution: every run of it, test runs included, executes the stage's live
 * copy with the stage's settings (core/automationRunner/definitionForRun.js). Cowork could then neither run exactly
 * the copy that was approved nor hold the run's notifications to the owner, so such an automation is no plan source.
 *
 * One rule for making a plan, approving it, trying it and running it; anything else reads as "no such automation".
 */

import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);

export interface SourceRow {
    id: string;
    userId: string;
    organizationId?: string | null;
    kind?: string | null;
    projectId?: string | null;
    definition?: unknown;
    [key: string]: unknown;
}

export interface SourceDeps {
    getAutomation: (id: string) => Promise<SourceRow | null>;
    /** The automation is managed by a Solution stage. */
    isManaged: (automation: SourceRow) => Promise<boolean>;
}

/** The real answer: the stage lookup the write guard uses (stores/managedPartsDefault.js). */
export async function isManagedByStage(automation: SourceRow): Promise<boolean> {
    if (typeof automation.projectId !== 'string' || !automation.projectId) return false;
    const { managedInfo } = nodeRequire('../../../stores/managedPartsDefault.js') as { managedInfo: (projectId: string) => Promise<unknown> };
    return !!(await managedInfo(automation.projectId));
}

export async function planSourceOf(automationId: string | null | undefined, userId: string, deps: SourceDeps): Promise<SourceRow | null> {
    if (!automationId) return null;
    const automation = await deps.getAutomation(automationId);
    if (!automation || automation.userId !== userId) return null;
    if (automation.kind && automation.kind !== 'automation') return null;
    return (await deps.isManaged(automation)) ? null : automation;
}
