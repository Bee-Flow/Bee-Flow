/**
 * The Account group: Settings, and its children — each one also inside
 * /settings, listed here so the map and the search find them by name. Order
 * here is the order the map lists them in.
 */

import { destination } from '../destination';
import type { Destination } from '../types';

export const ACCOUNT: Destination[] = [
    destination({
        id: 'settings',
        label: { i18nKey: 'sidebar.settings', en: 'Settings' },
        hint: { i18nKey: 'mobile.sitemap.settings.hint', en: 'Everything about this app and this account' },
        icon: 'Settings',
        href: '/settings',
        group: 'Account',
        keywords: ['preferences', 'options'],
    }),
    destination({
        id: 'appearance',
        label: { i18nKey: 'settings.appearance', en: 'Appearance' },
        hint: { i18nKey: 'mobile.sitemap.appearance.hint', en: 'Theme, accent and how the app looks' },
        icon: 'Droplet',
        href: '/settings/appearance',
        group: 'Account',
        keywords: ['theme', 'dark', 'light', 'colour', 'color', 'glass'],
    }),
    destination({
        id: 'account',
        label: { i18nKey: 'settings.account', en: 'Account' },
        hint: { i18nKey: 'mobile.sitemap.account.hint', en: 'Name, avatar and your data' },
        icon: 'User',
        href: '/settings/account',
        group: 'Account',
        keywords: ['profile', 'email', 'export', 'delete', 'gdpr'],
    }),
    destination({
        id: 'security',
        label: { i18nKey: 'settings.security', en: 'Security' },
        hint: { i18nKey: 'mobile.sitemap.security.hint', en: 'App lock, password, two-factor and encryption' },
        icon: 'Lock',
        href: '/settings/security',
        group: 'Account',
        keywords: ['2fa', 'mfa', 'biometrics', 'fingerprint', 'encryption', 'recovery', 'password', 'sign out'],
    }),
    destination({
        id: 'notification-settings',
        label: { i18nKey: 'settings.notifications', en: 'Notification settings' },
        hint: { i18nKey: 'mobile.sitemap.notification_settings.hint', en: 'What Bee Flow tells you about, and when' },
        icon: 'Bell',
        href: '/settings/notifications',
        group: 'Account',
        keywords: ['push', 'alerts', 'quiet'],
    }),
    destination({
        id: 'language',
        label: { i18nKey: 'settings.language', en: 'Language' },
        hint: { i18nKey: 'mobile.sitemap.language.hint', en: 'The language of the app itself' },
        icon: 'Globe',
        href: '/settings/language',
        group: 'Account',
        keywords: ['locale', 'translation', 'nederlands', 'english'],
    }),
    destination({
        id: 'server',
        label: { i18nKey: 'mobile.sitemap.server.label', en: 'Server' },
        hint: { i18nKey: 'mobile.sitemap.server.hint', en: 'Which Bee Flow this app talks to' },
        icon: 'Server',
        href: '/settings/server',
        group: 'Account',
        keywords: ['host', 'url', 'self-host', 'connection', 'switch'],
    }),
];
