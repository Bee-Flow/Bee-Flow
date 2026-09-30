/**
 * The Settings hub and this device's own settings: language, notifications,
 * the server, About — plus the boot-time locale sync. Import from
 * '@/features/settings', never from its internals. `useServerHealth` is the
 * one `/api/health` probe Administration and Support share with this hub.
 */

export { LocaleSync } from './components/LocaleSync';
export { useServerHealth } from './hooks/queries';
export { AboutScreen } from './screens/AboutScreen';
export { LanguageScreen } from './screens/LanguageScreen';
export { NotificationSettingsScreen } from './screens/NotificationSettingsScreen';
export { ServerScreen } from './screens/ServerScreen';
export { SettingsScreen } from './screens/SettingsScreen';
