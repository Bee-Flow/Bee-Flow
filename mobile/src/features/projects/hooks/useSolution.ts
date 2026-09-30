/**
 * Everything one Solution's object screen reads before any tab opens: the
 * project, the caller's role, the checks (the publish gate is not a property
 * of whichever tab is open), the Blueprint gallery (the version chip and the
 * update banner resolve through it) and the install count (a tab badge).
 *
 * The role comes from the resources listing, which carries the caller's
 * authoritative role; the project's own answer covers the gap until it loads.
 */

import { useHasLicenseFeature } from '@/core/access';

import { useProject, useProjectResources } from './queries';
import { useBlueprints, useCompleteness, useInstallCounts } from './solutionQueries';
import { blueprintVersionFor, controlBadge, publishAllowed } from '../model/checks';
import type { BlueprintMeta } from '../model/package';
import { installsBadge } from '../model/releases';
import type { ProjectDetail, ProjectRole } from '../model/types';
import { updateAvailability, type Availability } from '../model/upgrade';

/** The update banner's answer. A failed gallery read is "unknown", never "up to date". */
function availabilityFor(project: ProjectDetail | null | undefined, gallery: BlueprintMeta[] | null | undefined): Availability {
    return updateAvailability({
        installedFromBlueprintId: project?.installedFromBlueprintId ?? null,
        installedVersion: project?.installedVersion ?? null,
        blueprints: gallery,
    });
}

export function useSolution(id: string) {
    const packaging = useHasLicenseFeature('blueprint_packaging');
    const project = useProject(id);
    const resources = useProjectResources(id);
    const completeness = useCompleteness(id);
    const role: ProjectRole = resources.data?.role ?? project.data?.role ?? 'viewer';
    const isOwner = role === 'owner';
    const blueprints = useBlueprints(packaging);
    const installs = useInstallCounts(id, packaging && isOwner);

    // A failed re-check drops the earlier answer instead of keeping it: a
    // "nothing blocking" from before must not leave publishing open.
    const checks = completeness.isError ? null : completeness.data;
    const availability = availabilityFor(project.data, blueprints.isError ? null : blueprints.data);

    return {
        project,
        resources,
        completeness,
        role,
        isOwner,
        canEdit: role === 'owner' || role === 'editor',
        /** Blueprint packaging is on this plan: publish, export, versions, installs, upgrades. */
        packaging,
        version: blueprintVersionFor(blueprints.data, id),
        availability: packaging ? availability : null,
        canPublish: isOwner && packaging && publishAllowed(checks),
        checkCount: controlBadge(checks).count,
        installCount: installsBadge(installs.data),
    };
}

export type SolutionState = ReturnType<typeof useSolution>;
