import { Activity, BarChart3, ThumbsUp, Clock, AlertTriangle, Users, Coins } from 'lucide-react';
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

export const RANGES = [
    { id: 'today', labelKey: 'admin.mon_today' },
    { id: '7d', labelKey: 'admin.mon_7d' },
    { id: '30d', labelKey: 'admin.mon_30d' },
    { id: 'all', labelKey: 'admin.mon_all_time' },
    { id: 'custom', labelKey: 'admin_monitoring.range_custom', label: 'Custom' },
];

/** The monitor's pages, in the order of the section list; the id is the last URL segment (admin/monitoring/<id>). */
export const PAGES = [
    { id: 'overview', labelKey: 'admin.mon_overview', icon: BarChart3, descriptionKey: 'admin_monitoring.desc_overview', description: 'Dashboard & cost overview' },
    { id: 'adoption', labelKey: 'adoption.tab', label: 'Adoption', icon: Users, descriptionKey: 'admin_monitoring.desc_adoption', description: 'Who uses AI, what they build and where the spend goes' },
    { id: 'spend', labelKey: 'usage.tab_spend', label: 'Spend', icon: Coins, descriptionKey: 'admin_monitoring.desc_spend', description: 'Where the money goes: models, people, agents and sources' },
    { id: 'usage', labelKey: 'admin.mon_usage_explorer', icon: Activity, descriptionKey: 'admin_monitoring.desc_usage', description: 'Explore models, agents, users & conversations' },
    { id: 'feedback', labelKey: 'admin.mon_feedback', icon: ThumbsUp, descriptionKey: 'admin_monitoring.desc_feedback', description: 'User feedback on AI responses' },
    { id: 'activity', labelKey: 'admin.mon_activity', icon: Clock, descriptionKey: 'admin_monitoring.desc_activity', description: 'Recent API call log' },
    { id: 'terminations', labelKey: 'admin.mon_terminations', icon: AlertTriangle, descriptionKey: 'admin_monitoring.desc_terminations', description: 'Prematurely ended tasks & errors' },
];

/** The page a URL segment names; Overview when it is missing or unknown (bare admin/monitoring). */
export function monitoringPageOf(segment: string | undefined): string {
    return PAGES.some(p => p.id === segment) ? String(segment) : 'overview';
}

/** The licence capability every page but Overview needs (Overview is open to every admin who reaches the tab). */
export const ADVANCED_PAGES_FEATURE = 'advanced_usage_monitoring';

/** May a viewer with (or without) the advanced-monitoring capability open this page? */
export function isPageAllowedFor(pageId: string, hasAdvanced: boolean): boolean {
    return pageId === 'overview' || hasAdvanced;
}
