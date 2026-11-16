import { BarChart3, ThumbsUp, Clock, AlertTriangle, Users, Coins } from 'lucide-react';
import type { CoveredScope } from './shared.types';

export const API = (import.meta.env.VITE_API_URL || '') + '/api/usage';

export const AI_API = (import.meta.env.VITE_API_URL || '') + '/ai';

export const FEEDBACK_API = (import.meta.env.VITE_API_URL || '') + '/api/feedback';

/**
 * The Feedback endpoint for what the page covers: the `/org` variant when the
 * usage answer covers one organisation (anyone but a platform admin, or a
 * platform admin who named one with `?orgId`), the instance-wide route when
 * it covers every organisation or does not say. Terminations keeps its
 * generic route, which already scopes a caller to their own organisation.
 */
export function scopedApi(base: string, scope: CoveredScope | null | undefined): string {
    return scope?.organizationId ? `${base}/org` : base;
}

/** The monitor's periods (the shared RangeControl's preset ids; monitoring.helpers turns them into filters). */
export const RANGES: readonly { id: string }[] = [
    { id: 'today' }, { id: '7d' }, { id: '30d' }, { id: 'all' }, { id: 'custom' },
];

/** The monitor's pages, in the order of the section list; the id is the last URL segment (admin/monitoring/<id>). The labels are the rail's child rows'. */
export const PAGES = [
    { id: 'overview', labelKey: 'admin_nav.mon_overview', label: 'Overview', icon: BarChart3, descriptionKey: 'admin_monitoring.desc_overview', description: 'Dashboard & cost overview' },
    { id: 'adoption', labelKey: 'admin_nav.mon_adoption', label: 'Adoption', icon: Users, descriptionKey: 'admin_monitoring.desc_adoption', description: 'Who uses AI, what they build and where the spend goes' },
    { id: 'spend', labelKey: 'admin_nav.mon_spend', label: 'Spend', icon: Coins, descriptionKey: 'admin_monitoring.desc_spend', description: 'Where the money goes: models, people, agents and sources' },
    { id: 'feedback', labelKey: 'admin_nav.mon_feedback', label: 'Feedback', icon: ThumbsUp, descriptionKey: 'admin_monitoring.desc_feedback', description: 'User feedback on AI responses' },
    { id: 'activity', labelKey: 'admin_nav.mon_activity', label: 'Activity', icon: Clock, descriptionKey: 'admin_monitoring.desc_activity', description: 'Recent API call log' },
    { id: 'terminations', labelKey: 'admin_nav.mon_terminations', label: 'Terminations', icon: AlertTriangle, descriptionKey: 'admin_monitoring.desc_terminations', description: 'Prematurely ended tasks & errors' },
];

/**
 * Pages that were merged into another one, by their old URL segment: the
 * Usage explorer's tables are Spend's views now (its conversations included),
 * so an old admin/monitoring/usage link opens Spend.
 */
const MERGED_PAGES: Readonly<Record<string, string>> = { usage: 'spend' };

/** The page a URL segment names; Overview when it is missing or unknown (bare admin/monitoring). */
export function monitoringPageOf(segment: string | undefined): string {
    const id = segment && Object.hasOwn(MERGED_PAGES, segment) ? MERGED_PAGES[segment] : segment;
    return PAGES.some(p => p.id === id) ? String(id) : 'overview';
}

/** The licence capability every page but Overview needs (Overview is open to every admin who reaches the tab). */
export const ADVANCED_PAGES_FEATURE = 'advanced_usage_monitoring';

/** May a viewer with (or without) the advanced-monitoring capability open this page? */
export function isPageAllowedFor(pageId: string, hasAdvanced: boolean): boolean {
    return pageId === 'overview' || hasAdvanced;
}
