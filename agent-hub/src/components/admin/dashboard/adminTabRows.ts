// The sections of the dashboard's tabs that are rows of the rail themselves
// (AdminTab.railRows; the Organisation tab's own come from organisation/
// orgSections): a hub's sections are rail rows or child rows, never a second
// navigation column inside the pane. Pure data, read by adminTabs.

import {
    AlertTriangle, BarChart3, BookLock, Bot, Clock, Coins, Database, Globe, KeyRound, Mail, Mic,
    Package, Palette, Settings, Shield, ShieldAlert, ShieldCheck, SlidersHorizontal, Sparkles, ThumbsUp, ToggleLeft, Users,
} from 'lucide-react';
import { ADVANCED_PAGES_FEATURE, isPageAllowedFor } from '@/components/admin/monitoring/monitoring.constants';
import { SUBSCRIPTIONS_SECTIONS } from '@/components/admin/subscriptions/subscriptionsSections';
import type { AdminRailGateContext, AdminRailRowDef } from './adminRailRowDef';

type ChildDef = Pick<AdminRailRowDef, 'section' | 'labelKey' | 'labelFallback' | 'descriptionKey' | 'descriptionFallback' | 'icon' | 'gate'>;

/** Where a hub's own row sits: its children sit there too. */
type Parent = Pick<AdminRailRowDef, 'group' | 'block'>;

/** Child rows: indented under their tab's row while it is open, in the group and block of that row. */
function children(parent: Parent, defs: readonly ChildDef[]): AdminRailRowDef[] {
    return defs.map(def => ({ ...def, group: parent.group, block: parent.block, kind: 'child' }));
}

/** Agents: the organisation's chat agents, and the server-wide system agents in the whole-server block. */
export const AGENT_RAIL_ROWS: readonly AdminRailRowDef[] = [
    {
        section: 'chat', labelKey: 'admin_nav.agents', labelFallback: 'Agents',
        descriptionKey: 'admin_nav.agents_desc', descriptionFallback: "The organisation's chat agents: what they know, which tools they use and who may use them.",
        icon: Bot, group: 'ai', block: 'org', kind: 'row', gate: (c) => c.agentSections.includes('chat'),
    },
    {
        section: 'system', labelKey: 'admin_nav.system_agents', labelFallback: 'System agents',
        descriptionKey: 'admin_nav.system_agents_desc', descriptionFallback: 'The built-in agents this server runs for its own tasks.',
        icon: Settings, group: 'ai', block: 'instance', kind: 'row', gate: (c) => c.agentSections.includes('system'),
    },
];

/** AI configuration (the whole server). */
export const AI_CONFIG_RAIL_ROWS: readonly AdminRailRowDef[] = children({ group: 'ai', block: 'instance' }, [
    { section: 'providers', labelKey: 'admin_nav.ai_providers', labelFallback: 'Providers', descriptionKey: 'admin_nav.ai_providers_desc', descriptionFallback: 'The AI providers this server connects to, and their keys.', icon: KeyRound },
    { section: 'models', labelKey: 'admin_nav.models', labelFallback: 'Models', descriptionKey: 'admin_nav.ai_models_desc', descriptionFallback: 'Which model answers at each tier, for every organisation on this server.', icon: Sparkles },
    { section: 'retrieval', labelKey: 'admin_nav.ai_retrieval', labelFallback: 'Search & retrieval', descriptionKey: 'admin_nav.ai_retrieval_desc', descriptionFallback: 'How knowledge bases are indexed and searched, and how web search works.', icon: Database },
    { section: 'direct-chat', labelKey: 'admin_nav.ai_direct_chat', labelFallback: 'Direct chat', descriptionKey: 'admin_nav.ai_direct_chat_desc', descriptionFallback: 'How the chat without an agent behaves.', icon: Bot },
    // The section id stays `limits` (its address); the page is the read-only setup status now.
    { section: 'limits', labelKey: 'admin_nav.ai_limits', labelFallback: 'Setup status', descriptionKey: 'admin_nav.ai_limits_desc', descriptionFallback: 'What this server runs with now: search, reranking and the tool-round cap, each with a link to where it is set.', icon: SlidersHorizontal },
]);

const platformAdminOnly = (c: AdminRailGateContext) => c.isPlatformAdmin;

/**
 * Security: the organisation's Privacy Shield (saved by an organisation admin
 * of the home organisation only, the server's strict check), and the
 * server-wide sign-in providers and guardrail console (the console is Enterprise).
 */
export const SECURITY_RAIL_ROWS: readonly AdminRailRowDef[] = [
    {
        section: 'guardrails', labelKey: 'admin_nav.privacy_shield', labelFallback: 'Privacy Shield',
        descriptionKey: 'admin_nav.privacy_shield_desc', descriptionFallback: 'What is checked and masked before a message reaches an AI model.',
        icon: Shield, group: 'security', block: 'org', kind: 'row', gate: (c) => c.isPlatformAdmin || c.isHomeOrgAdmin,
    },
    {
        section: 'sso', labelKey: 'admin_nav.sso', labelFallback: 'Sign-in & SSO',
        descriptionKey: 'admin_nav.sso_desc', descriptionFallback: 'How people sign in to this server, and which email domains never add someone to an organisation by themselves.',
        icon: KeyRound, group: 'identity', block: 'instance', kind: 'row', gate: platformAdminOnly,
    },
    {
        section: 'guardrail-library', labelKey: 'admin_nav.guardrail_library', labelFallback: 'Guardrail library',
        descriptionKey: 'admin_nav.guardrail_library_desc', descriptionFallback: 'The patterns, term lists and profiles every organisation can use in its Privacy Shield.',
        icon: ShieldCheck, group: 'identity', block: 'instance', kind: 'row', gate: (c) => c.isPlatformAdmin && c.hasTier('enterprise'),
    },
];

/**
 * Platform services (the old Integrations tab): the gates are its sections' own
 * (IntegrationsAdminPanel/sections). Connected apps holds the Google Maps key,
 * which every tier uses, so it has no tier gate; Email stays Enterprise.
 */
export const PLATFORM_SERVICES_RAIL_ROWS: readonly AdminRailRowDef[] = children({ group: 'connections', block: 'instance' }, [
    { section: 'defaults', labelKey: 'admin_nav.ps_defaults', labelFallback: 'Defaults for new organisations', descriptionKey: 'admin_nav.ps_defaults_desc', descriptionFallback: 'The integrations a new organisation starts with.', icon: ToggleLeft },
    { section: 'email', labelKey: 'admin_nav.ps_email', labelFallback: 'Email', descriptionKey: 'admin_nav.ps_email_desc', descriptionFallback: 'The account this server sends its email from.', icon: Mail, gate: (c) => c.hasTier('enterprise') },
    { section: 'transcription', labelKey: 'admin_nav.ps_transcription', labelFallback: 'Transcription', descriptionKey: 'admin_nav.ps_transcription_desc', descriptionFallback: 'Which service turns meeting recordings into text, with who said what.', icon: Mic, gate: (c) => c.hasFeature('meeting_notes') },
    { section: 'connected-apps', labelKey: 'admin_nav.ps_connected_apps', labelFallback: 'Connected apps', descriptionKey: 'admin_nav.ps_connected_apps_desc', descriptionFallback: 'The keys of outside services that people can then connect to.', icon: Globe },
    { section: 'sanctions-lists', labelKey: 'sanctions.title', labelFallback: 'Sanctions lists', descriptionKey: 'sanctions.rail_desc', descriptionFallback: 'The official sanctions lists this server imports, and their last refresh.', icon: ShieldAlert, gate: (c) => c.hasFeature('sanctions_screening') },
]);

const advancedPage = (id: string) => (c: AdminRailGateContext) => isPageAllowedFor(id, c.hasFeature(ADVANCED_PAGES_FEATURE));

/**
 * Usage & monitoring (the descriptions are the monitoring pages' own; the frame
 * names the page only, the panel shows the description in the header's one small
 * line, joined with the scope, beside the period). The Usage explorer
 * is part of Spend now (alias monitoring/usage). Overview for every admin of the tab, the other pages
 * with the advanced-monitoring capability; Feedback also for a platform admin
 * or an organisation admin of the home organisation only (the `/org` route).
 */
export const MONITORING_RAIL_ROWS: readonly AdminRailRowDef[] = children({ group: 'organisation', block: 'org' }, [
    { section: 'overview', labelKey: 'admin_nav.mon_overview', labelFallback: 'Overview', descriptionKey: 'admin_monitoring.desc_overview', descriptionFallback: 'Dashboard & cost overview', icon: BarChart3 },
    { section: 'adoption', labelKey: 'admin_nav.mon_adoption', labelFallback: 'Adoption', descriptionKey: 'admin_monitoring.desc_adoption', descriptionFallback: 'Who uses AI, what they build and where the spend goes', icon: Users, gate: advancedPage('adoption') },
    { section: 'spend', labelKey: 'admin_nav.mon_spend', labelFallback: 'Spend', descriptionKey: 'admin_monitoring.desc_spend', descriptionFallback: 'Where the money goes: models, people, agents and sources', icon: Coins, gate: advancedPage('spend') },
    { section: 'feedback', labelKey: 'admin_nav.mon_feedback', labelFallback: 'Feedback', descriptionKey: 'admin_monitoring.desc_feedback', descriptionFallback: 'User feedback on AI responses', icon: ThumbsUp, gate: (c) => advancedPage('feedback')(c) && (c.isPlatformAdmin || c.isHomeOrgAdmin) },
    { section: 'activity', labelKey: 'admin_nav.mon_activity', labelFallback: 'Activity', descriptionKey: 'admin_monitoring.desc_activity', descriptionFallback: 'Recent API call log', icon: Clock, gate: advancedPage('activity') },
    { section: 'terminations', labelKey: 'admin_nav.mon_terminations', labelFallback: 'Terminations', descriptionKey: 'admin_monitoring.desc_terminations', descriptionFallback: 'Prematurely ended tasks & errors', icon: AlertTriangle, gate: advancedPage('terminations') },
]);

/**
 * Licence & features: the server licence, and the global feature switches (no
 * description: the list opens on its own note, which says what they do and when
 * a change applies).
 */
export const LICENSE_RAIL_ROWS: readonly AdminRailRowDef[] = children({ group: 'platform', block: 'instance' }, [
    { section: 'server', labelKey: 'admin_nav.server_licence', labelFallback: 'Server licence', descriptionKey: 'admin_nav.server_licence_desc', descriptionFallback: 'The licence key of this server and what it includes.', icon: BookLock },
    { section: 'features', labelKey: 'admin_nav.feature_switches', labelFallback: 'Feature switches', icon: ToggleLeft },
]);

/** Appearance: the server's look, and the icon packs. */
export const APPEARANCE_RAIL_ROWS: readonly AdminRailRowDef[] = children({ group: 'platform', block: 'instance' }, [
    { section: 'look', labelKey: 'admin_nav.look', labelFallback: 'Look', descriptionKey: 'admin_nav.look_desc', descriptionFallback: 'Colours, fonts, logo and name of this server.', icon: Palette },
    { section: 'icon-packs', labelKey: 'admin_nav.icon_packs', labelFallback: 'Icon packs', descriptionKey: 'admin_nav.icon_packs_desc', descriptionFallback: 'The icon sets people can choose from.', icon: Package },
]);

/**
 * Subscriptions (Bee Flow Cloud, the whole server): its sections, once a second
 * column inside the pane (SubscriptionsPanel nav={false} now). The ids are the
 * addresses it always had (admin/subscriptions/<section>), so old links land;
 * admin/subscriptions alone opens Plans, the first child. No description: each
 * page opens on its own.
 */
export const SUBSCRIPTIONS_RAIL_ROWS: readonly AdminRailRowDef[] = children(
    { group: 'operations', block: 'instance' },
    SUBSCRIPTIONS_SECTIONS.map(({ id, icon, labelKey, label }) => ({ section: id, labelKey, labelFallback: label, icon })),
);
