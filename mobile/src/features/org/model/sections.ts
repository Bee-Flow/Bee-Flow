/**
 * The organisation's settings sections, in the web's order.
 *
 * The web lists them in two places that concatenate: orgInfoShared.jsx
 * `SECTIONS` (licence … info) and AdvancedSettings.jsx `BASE_ORG_SUB_ITEMS`
 * (usage … meeting templates), with Azure appended on self-hosted. The ids,
 * label keys and order are pinned by sections.lockstep.test.ts; the web URL
 * segment (settingsRoutes.js SETTINGS_ORG_ID_TO_URL) is how a deep link finds
 * the row. `href` is where the section lives on the phone.
 *
 * The phone adds two rows the web keeps elsewhere: the org theme (the web's
 * Theme Studio under Appearance) and the system knowledge bases (the legacy
 * /app/org-settings/knowledge-bases tab). Access and feature grants (the
 * admin dashboard's Access tab) open from Users & Groups, not from the index.
 *
 * The index draws the sections in ORG_HUB_GROUPS: a handful of themed groups
 * rather than one list of sixteen rows. The grouping is the phone's; the web
 * order above stays the source of the ids and keys.
 */

import type { IconName } from '@/shared/ui';

export type WebOrgSectionId =
    | 'license'
    | 'auth'
    | 'privacy'
    | 'encryption'
    | 'ai_context'
    | 'integration_cache'
    | 'info'
    | 'org_usage'
    | 'org_compliance'
    | 'org_users'
    | 'org_academy'
    | 'org_integrations'
    | 'org_github_sync'
    | 'org_nextcloud_sync'
    | 'org_meeting_templates'
    | 'org_azure';

export type MobileOrgSectionId = 'theme' | 'knowledge_bases';

export type OrgSectionId = WebOrgSectionId | MobileOrgSectionId;

export interface OrgSection {
    id: OrgSectionId;
    /** The web's label key (both dictionaries), or a `mobile.org.*` one. */
    labelKey: string;
    label: string;
    icon: IconName;
    /** The web's accent for the row glyph. */
    color: string;
    href: string;
}

/** orgInfoShared.jsx SECTIONS, then BASE_ORG_SUB_ITEMS, then AZURE_SUB_ITEM. */
export const WEB_ORG_SECTIONS: readonly OrgSection[] = [
    { id: 'license', labelKey: 'settings.license_usage', label: 'License & Usage', icon: 'CreditCard', color: '#3b82f6', href: '/org/billing' },
    { id: 'auth', labelKey: 'settings.signin_method', label: 'Sign-in Method', icon: 'KeyRound', color: '#10b981', href: '/org/sign-in' },
    { id: 'privacy', labelKey: 'settings.privacy_shield', label: 'Privacy Shield', icon: 'Shield', color: '#ef4444', href: '/org/shield' },
    { id: 'encryption', labelKey: 'settings.encryption', label: 'Encryption', icon: 'Lock', color: '#8b5cf6', href: '/org/encryption' },
    { id: 'ai_context', labelKey: 'settings.ai_context', label: 'Conversation Memory', icon: 'Brain', color: '#f59e0b', href: '/org/ai-context' },
    { id: 'integration_cache', labelKey: 'settings.integration_cache', label: 'Answer Reuse', icon: 'DatabaseZap', color: '#06b6d4', href: '/org/integration-cache' },
    { id: 'info', labelKey: 'settings.org_info', label: 'Organisation Info', icon: 'Info', color: '#14b8a6', href: '/org/info' },
    { id: 'org_usage', labelKey: 'settings.usage_monitoring', label: 'Usage & Monitoring', icon: 'BarChart3', color: '#f59e0b', href: '/org/usage' },
    { id: 'org_compliance', labelKey: 'settings.compliance', label: 'Compliance', icon: 'Scale', color: 'compliance', href: '/org/compliance' },
    { id: 'org_users', labelKey: 'settings.users_groups', label: 'Users & Groups', icon: 'Users', color: '#3b82f6', href: '/org/people' },
    { id: 'org_academy', labelKey: 'settings.academy', label: 'Academy', icon: 'GraduationCap', color: '#059669', href: '/org/academy' },
    { id: 'org_integrations', labelKey: 'settings.integrations', label: 'Integrations', icon: 'Link2', color: '#0ea5e9', href: '/org/integrations' },
    { id: 'org_github_sync', labelKey: 'settings.github_sync', label: 'GitHub Sync', icon: 'FolderGit2', color: '#8b5cf6', href: '/org/github-sync' },
    { id: 'org_nextcloud_sync', labelKey: 'settings.nextcloud_sync', label: 'Nextcloud Sync', icon: 'Cloud', color: '#0082C9', href: '/org/nextcloud' },
    { id: 'org_meeting_templates', labelKey: 'settings.meeting_templates', label: 'Meeting templates', icon: 'FileText', color: '#a855f7', href: '/org/meeting-templates' },
    { id: 'org_azure', labelKey: 'settings.azure_config', label: 'Azure Configuration', icon: 'Cloud', color: '#0078D4', href: '/org/azure' },
];

/** The phone's extra rows, listed after the web's. */
export const MOBILE_ORG_SECTIONS: readonly OrgSection[] = [
    { id: 'theme', labelKey: 'mobile.org.section_theme', label: 'Theme', icon: 'Palette', color: '#ec4899', href: '/org/theme' },
    { id: 'knowledge_bases', labelKey: 'mobile.org.section_knowledge_bases', label: 'System knowledge bases', icon: 'Library', color: '#0d9488', href: '/org/knowledge-bases' },
];

export const ORG_SECTIONS: readonly OrgSection[] = [...WEB_ORG_SECTIONS, ...MOBILE_ORG_SECTIONS];

export interface OrgHubGroup {
    id: 'organisation' | 'people' | 'privacy' | 'ai' | 'integrations' | 'monitoring';
    /** The web's key where both dictionaries have the word, else `mobile.org.*`; `en` is the fallback. */
    title: { i18nKey: string; en: string };
    sections: readonly OrgSectionId[];
}

/** The index's groups; every section sits in exactly one (orgHub.test.ts). */
export const ORG_HUB_GROUPS: readonly OrgHubGroup[] = [
    { id: 'organisation', title: { i18nKey: 'settings.organisation', en: 'Organisation' }, sections: ['info', 'theme', 'auth', 'license'] },
    { id: 'people', title: { i18nKey: 'mobile.org.group_people', en: 'People & access' }, sections: ['org_users', 'org_academy'] },
    { id: 'privacy', title: { i18nKey: 'mobile.org.group_privacy', en: 'Privacy & security' }, sections: ['privacy', 'encryption', 'org_compliance'] },
    { id: 'ai', title: { i18nKey: 'mobile.org.group_ai', en: 'AI & data' }, sections: ['ai_context', 'integration_cache', 'knowledge_bases', 'org_meeting_templates'] },
    { id: 'integrations', title: { i18nKey: 'settings.integrations', en: 'Integrations' }, sections: ['org_integrations', 'org_github_sync', 'org_nextcloud_sync', 'org_azure'] },
    { id: 'monitoring', title: { i18nKey: 'admin.tab_monitoring', en: 'Monitoring' }, sections: ['org_usage'] },
];

export function orgSection(id: OrgSectionId): OrgSection {
    return ORG_SECTIONS.find((s) => s.id === id) as OrgSection;
}
