import { type DryRunIssue, type ResolveTargetFn } from './dryRunIssues';
import type { IssueTarget, PublishModalProps, TranslateFn } from './PublishModal.types';
import { GROUPS, ORG, PRIVATE } from './publishAccessSummary';
import { resolveTarget } from '@/components/shared/resolveTarget';
import toast from '@/components/shared/Toast';

/** Which audience the app is CURRENTLY published to. */
export function audienceOf(app: PublishModalProps['app'] | null | undefined): string {
    const published = !!(app?.isPublished ?? app?.is_published);
    if (!published) return PRIVATE;
    const groups = sharedGroupsOf(app);
    return groups.length > 0 ? GROUPS : ORG;
}

export function sharedGroupsOf(app: PublishModalProps['app'] | null | undefined): string[] {
    const g = app?.sharedGroups ?? app?.shared_groups;
    return Array.isArray(g) ? g.map((x) => String(x)).filter(Boolean) : [];
}

export function formatWhen(iso: string | null | undefined): string | null {
    if (!iso) return null;
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return null;
    return d.toLocaleString();
}

/**
 * Which audience the status line names. A function of t() rather than a
 * lookup table: a table of English is a sentence the Languages panel cannot
 * reach. The three cases are exhaustive — audienceOf() returns nothing else.
 */
export function audienceLabel(t: TranslateFn, audience: string): string {
    switch (audience) {
        case PRIVATE: return t('app_studio.publish.audience_private', 'Private draft');
        case ORG: return t('app_studio.publish.audience_org', 'Everyone in your organization');
        case GROUPS: return t('app_studio.publish.audience_groups', 'Specific groups');
        default: return '';
    }
}

/**
 * Walk a validator `path` ("screens[0].sections[1].children[2].props.title")
 * down the definition to the thing the editor can actually select: the
 * deepest addressed section/element id, plus the page it sits on. Trailing
 * segments that aren't a screen/section/child step (props, filters, …) stop
 * the walk — they address a field inside the node we already found.
 * Returns null when the path doesn't start at a real screen.
 *
 * The walk itself lives in shared/resolveTarget.js — the one deep-link
 * resolver every "Show me" goes through; this keeps the modal's shape.
 */
export function resolveIssueTarget(definition: PublishModalProps['definition'], path: unknown): IssueTarget | null {
    if (typeof path !== 'string') return null;
    const hit = (resolveTarget as ResolveTargetFn)(definition, { path, kind: 'app' });
    return hit ? { screenId: hit.screenId, screenName: hit.screenName, nodeId: hit.nodeId } : null;
}

export function asIssueList(value: unknown): DryRunIssue[] {
    return Array.isArray(value) ? value.filter((e) => e && typeof e === 'object') : [];
}

/**
 * The screen a node id sits on, in the { nodeId, screenId, screenName } shape
 * "Show me" wants. resolveIssueTarget walks a validator PATH; the dry run
 * reports the component it actually executed, which only has an id. Same
 * resolver, other direction.
 */
export function resolveNodeScreen(definition: PublishModalProps['definition'], nodeId: string | null | undefined): IssueTarget | null {
    if (!definition || !nodeId) return null;
    const hit = (resolveTarget as ResolveTargetFn)(definition, { nodeId, kind: 'app' });
    return hit ? { nodeId, screenId: hit.screenId, screenName: hit.screenName } : null;
}

/**
 * What the dialog says after the Nextcloud-menu toggle. The server waited for
 * the org's connector, so the toast can be exact: "reload Nextcloud" only when
 * the icon is really there (or really gone); otherwise the connector's own
 * periodic check picks it up — "within a few minutes".
 */
export function ncMenuToast(t: TranslateFn, ncRes: { ncConnected?: boolean; ncSync?: string } | null | undefined, enabled: boolean) {
    if (ncRes?.ncConnected === false) {
        toast.info(t('app_studio.publish.nc_menu_not_connected', 'Saved — the app icon appears once your organization’s Nextcloud is connected to Bee Flow.'));
    } else if (ncRes?.ncSync === 'synced') {
        toast.success(enabled
            ? t('app_studio.publish.nc_menu_synced', 'Added to the Nextcloud app menu — reload Nextcloud to see it.')
            : t('app_studio.publish.nc_menu_removed', 'Removed from the Nextcloud app menu — reload Nextcloud to update it.'));
    } else {
        toast.info(t('app_studio.publish.nc_menu_pending', 'Saved — the icon appears in Nextcloud within a few minutes.'));
    }
}
