/**
 * The Account group: Settings, and its children — each one also inside
 * /settings, listed here so the map and the search find them by name. Order
 * here is the order the map lists them in.
 */

import type { Destination } from '../types';

export const ACCOUNT: Destination[] = [
    {
        id: 'settings',
        i18nKey: 'sidebar.settings',
        label: 'Settings',
        hint: 'Everything about this app and this account',
        icon: 'Settings',
        href: '/settings',
        group: 'Account',
        keywords: ['preferences', 'options'],
    },
    {
        id: 'appearance',
        i18nKey: 'settings.appearance',
        label: 'Appearance',
        hint: 'Theme, accent and how the app looks',
        icon: 'Droplet',
        href: '/settings/appearance',
        group: 'Account',
        keywords: ['theme', 'dark', 'light', 'colour', 'color', 'glass'],
    },
    {
        id: 'account',
        i18nKey: 'settings.account',
        label: 'Account',
        hint: 'Name, avatar and your data',
        icon: 'User',
        href: '/settings/account',
        group: 'Account',
        keywords: ['profile', 'email', 'export', 'delete', 'gdpr'],
    },
    {
        id: 'security',
        i18nKey: 'settings.security',
        label: 'Security',
        hint: 'App lock, password, two-factor and encryption',
        icon: 'Lock',
        href: '/settings/security',
        group: 'Account',
        keywords: ['2fa', 'mfa', 'biometrics', 'fingerprint', 'encryption', 'recovery', 'password', 'sign out'],
    },
    {
        id: 'notification-settings',
        i18nKey: 'settings.notifications',
        label: 'Notification settings',
        hint: 'What Bee Flow tells you about, and when',
        icon: 'Bell',
        href: '/settings/notifications',
        group: 'Account',
        keywords: ['push', 'alerts', 'quiet'],
    },
    {
        id: 'language',
        i18nKey: 'settings.language',
        label: 'Language',
        hint: 'The language of the app itself',
        icon: 'Globe',
        href: '/settings/language',
        group: 'Account',
        keywords: ['locale', 'translation', 'nederlands', 'english'],
    },
    {
        id: 'server',
        label: 'Server',
        hint: 'Which Bee Flow this app talks to',
        icon: 'Server',
        href: '/settings/server',
        group: 'Account',
        keywords: ['host', 'url', 'self-host', 'connection', 'switch'],
    },
];
