// The sections of the dashboard's tabs that are rows of the rail themselves
// (AdminTab.railRows; the Organisation tab's own come from organisation/
// orgSections): a hub's sections are rail rows or child rows, never a second
// navigation column inside the pane. Pure data, read by adminTabs.

import {
    Activity, AlertTriangle, BarChart3, BookLock, Bot, Clock, Coins, Database, Globe, KeyRound, Mail, Mic,
    Package, Palette, Settings, Shield, ShieldCheck, SlidersHorizontal, Sparkles, ThumbsUp, ToggleLeft, Users,
} from 'lucide-react';
import { ADVANCED_PAGES_FEATURE, isPageAllowedFor } from '@/components/admin/monitoring/monitoring.constants';
import type { AdminRailGateContext, AdminRailRowDef } from './adminRailRowDef';

type ChildDef = Pick<AdminRailRowDef, 'section' | 'labelKey' | 'labelFallback' | 'icon' | 'gate'>;

/** Child rows: indented under their tab's row while it is open (their group and block are the tab's). */
function children(defs: readonly ChildDef[]): AdminRailRowDef[] {
    return defs.map(def => ({ ...def, group: 'ai', block: 'instance', kind: 'child' }));
}

/** Agents: the organisation's chat agents, and the server-wide system agents in the whole-server block. */
export const AGENT_RAIL_ROWS: readonly AdminRailRowDef[] = [
    { section: 'chat', labelKey: 'admin_nav.agents', labelFallback: 'Agents', icon: Bot, group: 'ai', block: 'org', kind: 'row', gate: (c) => c.agentSections.includes('chat') },
    { section: 'system', labelKey: 'admin_nav.system_agents', labelFallback: 'System agents', icon: Settings, group: 'ai', block: 'instance', kind: 'row', gate: (c) => c.agentSections.includes('system') },
];

/** AI configuration (the whole server). */
export const AI_CONFIG_RAIL_ROWS: readonly AdminRailRowDef[] = children([
    { section: 'providers', labelKey: 'admin_nav.ai_providers', labelFallback: 'Providers', icon: KeyRound },
    { section: 'models', labelKey: 'admin_nav.models', labelFallback: 'Models', icon: Sparkles },
    { section: 'retrieval', labelKey: 'admin_nav.ai_retrieval', labelFallback: 'Search & retrieval', icon: Database },
    { section: 'direct-chat', labelKey: 'admin_nav.ai_direct_chat', labelFallback: 'Direct chat', icon: Bot },
    { section: 'limits', labelKey: 'admin_nav.ai_limits', labelFallback: 'Limits', icon: SlidersHorizontal },
]);

const platformAdminOnly = (c: AdminRailGateContext) => c.isPlatformAdmin;

/**
 * Security: the organisation's Privacy Shield (saved by an organisation admin
 * of the home organisation only, the server's strict check), and the
 * server-wide sign-in providers and guardrail console (the console is Enterprise).
 */
export const SECURITY_RAIL_ROWS: readonly AdminRailRowDef[] = [
    { section: 'guardrails', labelKey: 'admin_nav.privacy_shield', labelFallback: 'Privacy Shield', icon: Shield, group: 'security', block: 'org', kind: 'row', gate: (c) => c.isPlatformAdmin || c.isHomeOrgAdmin },
    { section: 'sso', labelKey: 'admin_nav.sso', labelFallback: 'Sign-in & SSO', icon: KeyRound, group: 'identity', block: 'instance', kind: 'row', gate: platformAdminOnly },
    { section: 'guardrail-library', labelKey: 'admin_nav.guardrail_library', labelFallback: 'Guardrail library', icon: ShieldCheck, group: 'identity', block: 'instance', kind: 'row', gate: (c) => c.isPlatformAdmin && c.hasTier('enterprise') },
];

/** Platform services (the old Integrations tab): the gates are its sections' own (IntegrationsAdminPanel/sections). */
export const PLATFORM_SERVICES_RAIL_ROWS: readonly AdminRailRowDef[] = children([
    { section: 'defaults', labelKey: 'admin_nav.ps_defaults', labelFallback: 'Defaults for new organisations', icon: ToggleLeft },
    { section: 'email', labelKey: 'admin_nav.ps_email', labelFallback: 'Email', icon: Mail, gate: (c) => c.hasTier('enterprise') },
    { section: 'transcription', labelKey: 'admin_nav.ps_transcription', labelFallback: 'Transcription', icon: Mic, gate: (c) => c.hasFeature('meeting_notes') },
    { section: 'connected-apps', labelKey: 'admin_nav.ps_connected_apps', labelFallback: 'Connected apps', icon: Globe, gate: (c) => c.hasTier('enterprise') },
]);

const advancedPage = (id: string) => (c: AdminRailGateContext) => isPageAllowedFor(id, c.hasFeature(ADVANCED_PAGES_FEATURE));

/**
 * Usage & monitoring: Overview for every admin of the tab, the other pages
 * with the advanced-monitoring capability; Feedback also for a platform admin
 * or an organisation admin of the home organisation only (the `/org` route).
 */
export const MONITORING_RAIL_ROWS: readonly AdminRailRowDef[] = children([
    { section: 'overview', labelKey: 'admin_nav.mon_overview', labelFallback: 'Overview', icon: BarChart3 },
    { section: 'adoption', labelKey: 'admin_nav.mon_adoption', labelFallback: 'Adoption', icon: Users, gate: advancedPage('adoption') },
    { section: 'spend', labelKey: 'admin_nav.mon_spend', labelFallback: 'Spend', icon: Coins, gate: advancedPage('spend') },
    { section: 'usage', labelKey: 'admin_nav.mon_usage', labelFallback: 'Usage explorer', icon: Activity, gate: advancedPage('usage') },
    { section: 'feedback', labelKey: 'admin_nav.mon_feedback', labelFallback: 'Feedback', icon: ThumbsUp, gate: (c) => advancedPage('feedback')(c) && (c.isPlatformAdmin || c.isHomeOrgAdmin) },
    { section: 'activity', labelKey: 'admin_nav.mon_activity', labelFallback: 'Activity', icon: Clock, gate: advancedPage('activity') },
    { section: 'terminations', labelKey: 'admin_nav.mon_terminations', labelFallback: 'Terminations', icon: AlertTriangle, gate: advancedPage('terminations') },
]);

/** Licence & features: the server licence, and the global feature switches. */
export const LICENSE_RAIL_ROWS: readonly AdminRailRowDef[] = children([
    { section: 'server', labelKey: 'admin_nav.server_licence', labelFallback: 'Server licence', icon: BookLock },
    { section: 'features', labelKey: 'admin_nav.feature_switches', labelFallback: 'Feature switches', icon: ToggleLeft },
]);

/** Appearance: the server's look, and the icon packs. */
export const APPEARANCE_RAIL_ROWS: readonly AdminRailRowDef[] = children([
    { section: 'look', labelKey: 'admin_nav.look', labelFallback: 'Look', icon: Palette },
    { section: 'icon-packs', labelKey: 'admin_nav.icon_packs', labelFallback: 'Icon packs', icon: Package },
]);
