/**
 * The Organisation group: the company, its people, its policies and its
 * spend. Order here is the order the map lists them in; the organisation's
 * own settings sections are in orgSettings.ts. There is no Administration
 * row: the web's global admin dashboard is not on the phone.
 */

import { destination } from '../destination';
import type { Destination } from '../types';
import { ORG_SETTINGS } from './orgSettings';

export const ORGANISATION: Destination[] = [
    destination({
        id: 'org',
        label: { i18nKey: 'settings.organisation', en: 'Organisation' },
        hint: { i18nKey: 'mobile.sitemap.org.hint', en: 'Your company profile and its settings' },
        icon: 'Briefcase',
        href: '/org',
        group: 'Organisation',
        keywords: ['company', 'tenant', 'workspace'],
    }),
    ...ORG_SETTINGS,
    destination({
        id: 'org-members',
        label: { i18nKey: 'mobile.sitemap.org_members.label', en: 'Members' },
        hint: { i18nKey: 'mobile.sitemap.org_members.hint', en: 'Everyone in your organisation, their role and status' },
        icon: 'Users',
        href: '/org/members',
        group: 'Organisation',
        gate: { anyPerms: ['org_admin', 'manage_users'] },
        keywords: ['people', 'users', 'permissions', 'groups', 'invite'],
    }),
    destination({
        id: 'org-privacy',
        label: { i18nKey: 'mobile.sitemap.org_privacy.label', en: 'Your privacy settings' },
        hint: { i18nKey: 'mobile.sitemap.org_privacy.hint', en: 'Your own Privacy Shield, PII handling and data-subject requests' },
        icon: 'Shield',
        href: '/org/privacy',
        group: 'Organisation',
        keywords: ['gdpr', 'pii', 'dsr', 'shield', 'redaction', 'compliance'],
    }),
    destination({
        id: 'webpages',
        label: { i18nKey: 'sidebar.webpages', en: 'Webpages' },
        hint: { i18nKey: 'mobile.sitemap.webpages.hint', en: 'Published pages, their links and how they are doing' },
        icon: 'Globe',
        href: '/webpages',
        group: 'Organisation',
        keywords: ['site', 'page', 'publish', 'cms', 'analytics'],
    }),
    destination({
        id: 'forms',
        label: { i18nKey: 'sidebar.forms', en: 'Forms' },
        hint: { i18nKey: 'mobile.sitemap.forms.hint', en: 'Shareable forms and the responses that came back' },
        icon: 'ClipboardList',
        href: '/forms',
        group: 'Organisation',
        keywords: ['survey', 'submission', 'response', 'intake'],
    }),
    destination({
        id: 'mcp',
        label: { i18nKey: 'mobile.sitemap.mcp.label', en: 'MCP servers' },
        hint: { i18nKey: 'mobile.sitemap.mcp.hint', en: 'Connected tool servers and their access tokens' },
        icon: 'Server',
        href: '/mcp',
        group: 'Organisation',
        keywords: ['model context protocol', 'tools', 'token'],
    }),
    destination({
        id: 'integrations',
        label: { i18nKey: 'settings.connections', en: 'Connections' },
        hint: { i18nKey: 'mobile.sitemap.integrations.hint', en: 'Connect Google, Microsoft and the rest' },
        icon: 'Link',
        href: '/integrations',
        group: 'Organisation',
        keywords: ['google', 'microsoft', 'gmail', 'outlook', 'connect', 'oauth', 'nextcloud', 'integrations'],
    }),
    destination({
        id: 'usage',
        label: { i18nKey: 'mobile.sitemap.usage.label', en: 'Usage and spend' },
        hint: { i18nKey: 'mobile.sitemap.usage.hint', en: 'What has been used this period, and what it cost' },
        icon: 'ChartNoAxesColumn',
        href: '/usage',
        group: 'Organisation',
        keywords: ['cost', 'tokens', 'quota', 'billing', 'plan', 'limit'],
    }),
];
