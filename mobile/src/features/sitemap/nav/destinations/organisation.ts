/**
 * The Organisation group: the company, its people, its policies and its
 * spend. Order here is the order the map lists them in; the organisation's
 * own settings sections are in orgSettings.ts. There is no Administration
 * row: the web's global admin dashboard is not on the phone.
 */

import type { Destination } from '../types';
import { ORG_SETTINGS } from './orgSettings';

export const ORGANISATION: Destination[] = [
    {
        id: 'org',
        label: 'Organisation',
        hint: 'Your company profile and its settings',
        icon: 'Briefcase',
        href: '/org',
        group: 'Organisation',
        keywords: ['company', 'tenant', 'workspace'],
    },
    ...ORG_SETTINGS,
    {
        id: 'org-members',
        label: 'Members',
        hint: 'Everyone in your organisation, their role and status',
        icon: 'Users',
        href: '/org/members',
        group: 'Organisation',
        gate: { anyPerms: ['org_admin', 'manage_users'] },
        keywords: ['people', 'users', 'permissions', 'groups', 'invite'],
    },
    {
        id: 'org-privacy',
        label: 'Your privacy settings',
        hint: 'Your own Privacy Shield, PII handling and data-subject requests',
        icon: 'Shield',
        href: '/org/privacy',
        group: 'Organisation',
        keywords: ['gdpr', 'pii', 'dsr', 'shield', 'redaction', 'compliance'],
    },
    {
        id: 'webpages',
        label: 'Webpages',
        hint: 'Published pages, their links and how they are doing',
        icon: 'Globe',
        href: '/webpages',
        group: 'Organisation',
        keywords: ['site', 'page', 'publish', 'cms', 'analytics'],
    },
    {
        id: 'forms',
        i18nKey: 'sidebar.forms',
        label: 'Forms',
        hint: 'Shareable forms and the responses that came back',
        icon: 'ClipboardList',
        href: '/forms',
        group: 'Organisation',
        keywords: ['survey', 'submission', 'response', 'intake'],
    },
    {
        id: 'mcp',
        label: 'MCP servers',
        hint: 'Connected tool servers and their access tokens',
        icon: 'Server',
        href: '/mcp',
        group: 'Organisation',
        keywords: ['model context protocol', 'tools', 'token'],
    },
    {
        id: 'integrations',
        i18nKey: 'settings.integrations',
        label: 'Integrations',
        hint: 'Connect Google, Microsoft and the rest',
        icon: 'Link',
        href: '/integrations',
        group: 'Organisation',
        keywords: ['google', 'microsoft', 'gmail', 'outlook', 'connect', 'oauth', 'nextcloud'],
    },
    {
        id: 'usage',
        label: 'Usage and spend',
        hint: 'What has been used this period, and what it cost',
        icon: 'ChartNoAxesColumn',
        href: '/usage',
        group: 'Organisation',
        keywords: ['cost', 'tokens', 'quota', 'billing', 'plan', 'limit'],
    },
];
