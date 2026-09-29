/**
 * The settings shape, its defaults, and the one function that turns anything
 * read off disk into a valid settings object.
 *
 * `normaliseSettings` is total: it never throws and always returns something
 * the app can run on. That is the whole point — a settings file is edited by
 * hand, synced between machines, half-written by a power cut and carried
 * forward across versions, and none of those are a reason for a workspace
 * client to refuse to start. An unreadable value is replaced by its default,
 * not treated as an error.
 */

import type { DesktopSettings, WatchedFolder } from '../../shared/types.ts';

/** Bumped only when a migration is needed; `normaliseSettings` handles the rest. */
export const SETTINGS_VERSION = 1;

/**
 * The default quick-ask accelerator, per platform.
 *
 * Ctrl/Cmd+Shift+Space is unclaimed on all three: macOS gives Cmd+Space to
 * Spotlight and Ctrl+Space to input switching, Windows gives Win+... to the
 * shell, and GNOME/KDE leave Shift+Space alone.
 */
export function defaultQuickAskAccelerator(platform: NodeJS.Platform = process.platform): string {
    return platform === 'darwin' ? 'Command+Shift+Space' : 'Control+Shift+Space';
}

export function defaultSettings(platform: NodeJS.Platform = process.platform): DesktopSettings {
    return {
        version: SETTINGS_VERSION,
        server: { url: '', recent: [], apiOrigin: '' },
        launch: {
            openAtLogin: false,
            startMinimised: false,
            // macOS apps conventionally stay in the Dock when their last window
            // closes; on Windows and Linux closing the window means closing the
            // window, and the tray is where a background app belongs.
            closeToTray: platform !== 'darwin',
        },
        shortcuts: { quickAsk: defaultQuickAskAccelerator(platform) },
        notifications: { enabled: true, onlyWhenUnfocused: true },
        updates: { enabled: true, automatic: true, channel: 'stable' },
        appearance: { theme: 'system', autoHideMenuBar: false, zoomLevel: 0 },
        nextcloud: {
            enabled: true,
            configPath: '',
            socketPath: '',
            saveFolder: '',
            watchedFolders: [],
        },
    };
}

/**
 * A second origin for the configured server, or '' — never on its own: an
 * apiOrigin without a server, or equal to it, or that is not http(s), is
 * dropped rather than kept as a navigation exception for nothing.
 */
function normaliseOrigin(value: unknown, serverUrl: string): string {
    if (!serverUrl || typeof value !== 'string' || !value) return '';
    try {
        const parsed = new URL(value);
        if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return '';
        return parsed.origin === new URL(serverUrl).origin ? '' : parsed.origin;
    } catch {
        return '';
    }
}

/**
 * The settings as the server's own page may see them.
 *
 * The workspace is a remote origin. It has no business knowing which OTHER
 * servers this person connects to, nor where on disk the Nextcloud client's
 * config and socket live — and a server page that could read `recent` would
 * learn about a user's other employers. Everything it can act on is kept.
 */
export function settingsForServerPage(settings: DesktopSettings): DesktopSettings {
    return {
        ...settings,
        server: { url: settings.server.url, recent: [], apiOrigin: '' },
        nextcloud: { ...settings.nextcloud, configPath: '', socketPath: '' },
    };
}

/** How many previously used servers the picker remembers. */
export const MAX_RECENT_SERVERS = 8;

function asBoolean(value: unknown, fallback: boolean): boolean {
    return typeof value === 'boolean' ? value : fallback;
}

function asString(value: unknown, fallback: string): string {
    return typeof value === 'string' ? value : fallback;
}

function asEnum<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
    return typeof value === 'string' && (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
}

/**
 * Zoom is clamped rather than validated away. Electron's zoom levels are
 * logarithmic steps either side of 0; past ±5 the UI is unusable, and a value
 * that came from a stuck Ctrl+scroll should be pulled back to something the
 * user can see well enough to fix.
 */
function asZoom(value: unknown, fallback: number): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
    return Math.max(-5, Math.min(5, Math.round(value * 2) / 2));
}

function asRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function normaliseWatchedFolders(value: unknown): WatchedFolder[] {
    if (!Array.isArray(value)) return [];
    const seen = new Set<string>();
    const out: WatchedFolder[] = [];
    for (const entry of value) {
        const row = asRecord(entry);
        const path = asString(row.path, '').trim();
        const knowledgeBaseId = asString(row.knowledgeBaseId, '').trim();
        // A watch without a folder or without somewhere to file what it finds
        // is not a half-configured watch, it is a no-op that would sit in the
        // settings window looking like it worked.
        if (!path || !knowledgeBaseId) continue;
        const id = asString(row.id, '').trim() || `watch-${out.length + 1}`;
        if (seen.has(id)) continue;
        seen.add(id);
        out.push({
            id,
            path,
            knowledgeBaseId,
            label: asString(row.label, '').trim() || basenameOf(path),
            enabled: asBoolean(row.enabled, true),
            recursive: asBoolean(row.recursive, true),
        });
    }
    return out;
}

/**
 * The last path segment, for both separators.
 *
 * Deliberately not `path.basename`: settings written on Windows are read on
 * Linux (a synced home directory, a bug report attached to an issue), and the
 * platform's own basename leaves `C:\Users\x\Docs` intact on POSIX.
 */
export function basenameOf(value: string): string {
    const trimmed = value.replace(/[\\/]+$/, '');
    const cut = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
    return cut === -1 ? trimmed : trimmed.slice(cut + 1);
}

function normaliseRecent(value: unknown, current: string): string[] {
    if (!Array.isArray(value)) return [];
    const seen = new Set<string>();
    const out: string[] = [];
    for (const entry of value) {
        if (typeof entry !== 'string') continue;
        const url = entry.trim().replace(/\/+$/, '');
        if (!url || url === current || seen.has(url)) continue;
        seen.add(url);
        out.push(url);
        if (out.length >= MAX_RECENT_SERVERS) break;
    }
    return out;
}

/**
 * Turn whatever was on disk into settings the app can run on.
 *
 * `platform` is a parameter rather than a read of `process.platform` so the
 * defaults can be tested for all three platforms from one machine — the
 * close-to-tray and accelerator defaults genuinely differ, and a test that can
 * only check the host's platform checks a third of the behaviour.
 */
export function normaliseSettings(raw: unknown, platform: NodeJS.Platform = process.platform): DesktopSettings {
    const defaults = defaultSettings(platform);
    const input = asRecord(raw);

    const server = asRecord(input.server);
    const launch = asRecord(input.launch);
    const shortcuts = asRecord(input.shortcuts);
    const notifications = asRecord(input.notifications);
    const updates = asRecord(input.updates);
    const appearance = asRecord(input.appearance);
    const nextcloud = asRecord(input.nextcloud);

    const serverUrl = asString(server.url, '').trim().replace(/\/+$/, '');

    return {
        version: SETTINGS_VERSION,
        server: {
            url: serverUrl,
            recent: normaliseRecent(server.recent, serverUrl),
            apiOrigin: normaliseOrigin(server.apiOrigin, serverUrl),
        },
        launch: {
            openAtLogin: asBoolean(launch.openAtLogin, defaults.launch.openAtLogin),
            startMinimised: asBoolean(launch.startMinimised, defaults.launch.startMinimised),
            closeToTray: asBoolean(launch.closeToTray, defaults.launch.closeToTray),
        },
        shortcuts: {
            quickAsk: asString(shortcuts.quickAsk, defaults.shortcuts.quickAsk),
        },
        notifications: {
            enabled: asBoolean(notifications.enabled, defaults.notifications.enabled),
            onlyWhenUnfocused: asBoolean(notifications.onlyWhenUnfocused, defaults.notifications.onlyWhenUnfocused),
        },
        updates: {
            enabled: asBoolean(updates.enabled, defaults.updates.enabled),
            automatic: asBoolean(updates.automatic, defaults.updates.automatic),
            channel: asEnum(updates.channel, ['stable', 'beta'] as const, defaults.updates.channel),
        },
        appearance: {
            theme: asEnum(appearance.theme, ['system', 'light', 'dark'] as const, defaults.appearance.theme),
            autoHideMenuBar: asBoolean(appearance.autoHideMenuBar, defaults.appearance.autoHideMenuBar),
            zoomLevel: asZoom(appearance.zoomLevel, defaults.appearance.zoomLevel),
        },
        nextcloud: {
            enabled: asBoolean(nextcloud.enabled, defaults.nextcloud.enabled),
            configPath: asString(nextcloud.configPath, '').trim(),
            socketPath: asString(nextcloud.socketPath, '').trim(),
            saveFolder: asString(nextcloud.saveFolder, '').trim(),
            watchedFolders: normaliseWatchedFolders(nextcloud.watchedFolders),
        },
    };
}

/**
 * Merge a partial patch into settings, one level into each section.
 *
 * Arrays replace rather than merge: a watched-folder list with one entry
 * removed has to be expressible, and a deep array merge cannot express it.
 */
export function mergeSettings(current: DesktopSettings, patch: unknown, platform: NodeJS.Platform = process.platform): DesktopSettings {
    const input = asRecord(patch);
    const merged: Record<string, unknown> = { ...(current as unknown as Record<string, unknown>) };
    for (const [key, value] of Object.entries(input)) {
        if (value === undefined) continue;
        const existing = (current as unknown as Record<string, unknown>)[key];
        if (value && typeof value === 'object' && !Array.isArray(value) && existing && typeof existing === 'object' && !Array.isArray(existing)) {
            merged[key] = { ...(existing as Record<string, unknown>), ...(value as Record<string, unknown>) };
        } else {
            merged[key] = value;
        }
    }
    return normaliseSettings(merged, platform);
}
