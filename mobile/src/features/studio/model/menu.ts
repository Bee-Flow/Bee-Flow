/**
 * Studio's destinations as one list of headed groups: the Workspace group
 * (Cowork, Apps, Forms, Notebooks — handed in already gated by the shell) and,
 * for a builder (canSeeStudio), every section under its Build / AI / Bundle
 * heading. The Studio hub and the drawer's Studio menu (features/shell) both
 * draw from this, so the two cannot list different things.
 */

import type { HubLink, ResolvedSection, StudioGroup } from './types';

export type StudioMenuRow =
    | { kind: 'link'; id: string; link: HubLink }
    | { kind: 'section'; id: string; section: ResolvedSection };

export interface StudioMenuGroup {
    id: string;
    labelKey: string;
    labelFallback: string;
    rows: StudioMenuRow[];
}

export interface StudioMenuInput {
    /** The Workspace rows, gated by the host; none draws no group. */
    workspace: readonly HubLink[];
    /** The resolved sections under their headings (useStudioNav().groups). */
    groups: readonly StudioGroup[];
    /** canSeeStudio: only a builder gets the sections. */
    builder: boolean;
}

export const WORKSPACE_GROUP_ID = 'workspace';

export function studioMenuGroups({ workspace, groups, builder }: StudioMenuInput): StudioMenuGroup[] {
    const out: StudioMenuGroup[] = [];
    if (workspace.length > 0) {
        out.push({
            id: WORKSPACE_GROUP_ID,
            labelKey: 'mobile.studio.workspace',
            labelFallback: 'Workspace',
            rows: workspace.map((link) => ({ kind: 'link', id: link.id, link })),
        });
    }
    if (!builder) return out;
    for (const { category, sections } of groups) {
        if (sections.length === 0) continue;
        out.push({
            id: category.id,
            labelKey: category.labelKey,
            labelFallback: category.labelFallback,
            rows: sections.map((section) => ({ kind: 'section', id: section.id, section })),
        });
    }
    return out;
}
