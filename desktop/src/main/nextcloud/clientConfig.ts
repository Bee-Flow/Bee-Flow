/**
 * Reading the Nextcloud desktop client's own configuration.
 *
 * This is the foundation of the whole bridge, and it is deliberately the part
 * that does not depend on the Nextcloud client being RUNNING. The socket API
 * (socketApi.ts) is better — it knows sync state, it can open the share dialog
 * — but it only answers while the client is up, and its socket path has moved
 * between releases and differs between a distro package, a Flatpak and a Snap.
 * The config file moves far less, and everything the bridge most needs (which
 * accounts exist, which folders are synced, and what each one maps to on the
 * server) is in it.
 *
 * The format is Qt's QSettings INI dialect, which is nearly but not quite INI:
 *   - keys nest with backslashes: `0\Folders\1\localPath`
 *   - values may be `\xNNNN`-escaped for anything non-ASCII
 *   - Windows paths are written with forward slashes
 *   - a value containing a comma is quoted; an unquoted comma makes a list
 * Parsing it by hand is a page of code; the alternative was an INI dependency
 * that gets three of those four wrong.
 */

import type { NextcloudAccount, NextcloudSyncFolder } from '../../shared/types.ts';

/** One `section → key → value` map, keys still in their nested form. */
export type ParsedIni = Map<string, Map<string, string>>;

/**
 * Where the client keeps `nextcloud.cfg`, most likely first.
 *
 * The Linux list is the long one on purpose: the same desktop client is shipped
 * as a distro package, a Flatpak and a Snap, and each sandbox puts the config
 * somewhere different. A user who installed it from Flathub — which is how most
 * people on Fedora and Silverblue get it — has nothing at ~/.config/Nextcloud
 * at all, and an integration that only looked there would report "Nextcloud not
 * installed" on a machine that is syncing perfectly well.
 */
export function configCandidates(env: NodeJS.ProcessEnv, platform: NodeJS.Platform, home: string): string[] {
    const candidates: string[] = [];
    const push = (...parts: string[]) => {
        const joined = parts.filter(Boolean).join('/').replace(/\/+/g, '/');
        if (joined && !candidates.includes(joined)) candidates.push(joined);
    };

    if (platform === 'win32') {
        const appData = env.APPDATA || `${home}/AppData/Roaming`;
        push(appData.replace(/\\/g, '/'), 'Nextcloud/nextcloud.cfg');
        push(appData.replace(/\\/g, '/'), 'ownCloud/owncloud.cfg');
        return candidates;
    }

    if (platform === 'darwin') {
        push(home, 'Library/Preferences/Nextcloud/nextcloud.cfg');
        push(home, 'Library/Application Support/Nextcloud/nextcloud.cfg');
        push(home, 'Library/Preferences/ownCloud/owncloud.cfg');
        return candidates;
    }

    const xdgConfig = env.XDG_CONFIG_HOME || `${home}/.config`;
    push(xdgConfig, 'Nextcloud/nextcloud.cfg');
    // Flatpak (com.nextcloud.desktopclient.nextcloud) — its own $XDG_CONFIG_HOME.
    push(home, '.var/app/com.nextcloud.desktopclient.nextcloud/config/Nextcloud/nextcloud.cfg');
    // Snap (nextcloud-desktop-client). `current` is a symlink to the live revision.
    push(home, 'snap/nextcloud-desktop-client/current/.config/Nextcloud/nextcloud.cfg');
    // Some distributions still ship the ownCloud-branded client alongside.
    push(xdgConfig, 'ownCloud/owncloud.cfg');
    return candidates;
}

/**
 * Undo QSettings' escaping.
 *
 * `\xNNNN` is how Qt writes anything outside ASCII, which on this file means
 * every folder with an umlaut, an accent or a Cyrillic character in its name —
 * not an edge case in a European product.
 */
export function unescapeIniValue(raw: string): string {
    let value = raw.trim();

    // A quoted value keeps its leading/trailing whitespace and its commas.
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
        value = value.slice(1, -1);
    }

    return value.replace(/\\x([0-9a-fA-F]{1,4})|\\([\\nrt0;=:"])/g, (match, hex: string | undefined, escaped: string | undefined) => {
        if (hex !== undefined) return String.fromCharCode(parseInt(hex, 16));
        switch (escaped) {
            case 'n':
                return '\n';
            case 'r':
                return '\r';
            case 't':
                return '\t';
            case '0':
                return '\0';
            default:
                return escaped ?? match;
        }
    });
}

/** Parse the INI text into sections. Unknown lines are skipped, never fatal. */
export function parseIni(text: string): ParsedIni {
    const sections: ParsedIni = new Map();
    let current = 'General';
    sections.set(current, new Map());

    for (const rawLine of text.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line || line.startsWith(';') || line.startsWith('#')) continue;

        if (line.startsWith('[') && line.endsWith(']')) {
            current = line.slice(1, -1).trim();
            if (!sections.has(current)) sections.set(current, new Map());
            continue;
        }

        const eq = line.indexOf('=');
        if (eq === -1) continue;
        const key = line.slice(0, eq).trim();
        const value = line.slice(eq + 1);
        if (!key) continue;
        sections.get(current)?.set(key, unescapeIniValue(value));
    }

    return sections;
}

/** Strip a trailing separator so two spellings of the same folder compare equal. */
export function trimTrailingSeparator(value: string): string {
    const trimmed = value.replace(/[\\/]+$/, '');
    // Keep the slash for a filesystem root ("/" on POSIX, "C:/" on Windows).
    return trimmed === '' || /^[A-Za-z]:$/.test(trimmed) ? `${trimmed}/` : trimmed;
}

/** Normalise a server path: leading slash, no trailing slash, POSIX separators. */
export function normaliseRemotePath(value: string): string {
    const cleaned = String(value ?? '')
        .replace(/\\/g, '/')
        .replace(/\/{2,}/g, '/');
    const withLead = cleaned.startsWith('/') ? cleaned : `/${cleaned}`;
    return withLead === '/' ? '/' : withLead.replace(/\/+$/, '');
}

interface FolderDraft {
    localPath?: string;
    targetPath?: string;
    virtualFilesMode?: string;
    accountId?: string;
}

/**
 * Turn the parsed INI into accounts and their sync folders.
 *
 * Two layouts are handled because both are in the wild: modern clients nest
 * folders under their account (`0\Folders\1\localPath` in `[Accounts]`), while
 * older ones — and any profile carried forward from them — keep a separate
 * `[Folders]` section whose entries name their account by alias. A user who has
 * had the client installed since before the migration has the second.
 */
export function accountsFrom(ini: ParsedIni): NextcloudAccount[] {
    const accounts = new Map<string, NextcloudAccount>();
    const folders = new Map<string, FolderDraft>();

    const accountsSection = ini.get('Accounts') ?? new Map<string, string>();

    for (const [key, value] of accountsSection) {
        const parts = key.split('\\');
        const accountId = parts[0];
        if (!accountId) continue;

        // `version=2` and friends live at the top of [Accounts] with no index.
        if (parts.length === 1) continue;

        if (parts[1] === 'Folders' && parts.length >= 4) {
            const folderKey = `${accountId}/${parts[2]}`;
            const draft = folders.get(folderKey) ?? { accountId };
            applyFolderField(draft, String(parts[3]), value);
            folders.set(folderKey, draft);
            continue;
        }

        const account = accounts.get(accountId) ?? emptyAccount(accountId);
        applyAccountField(account, String(parts[1]), value);
        accounts.set(accountId, account);
    }

    // The legacy [Folders] section: `<alias>\localPath`, plus `<alias>\backend`.
    for (const [sectionName, section] of ini) {
        if (sectionName !== 'Folders') continue;
        for (const [key, value] of section) {
            const parts = key.split('\\');
            const alias = parts[0];
            if (!alias || parts.length < 2) continue;
            const folderKey = `legacy/${alias}`;
            const draft = folders.get(folderKey) ?? { accountId: '0' };
            applyFolderField(draft, String(parts[1]), value);
            folders.set(folderKey, draft);
        }
    }

    for (const draft of folders.values()) {
        if (!draft.localPath) continue;
        const accountId = draft.accountId ?? '0';
        const account = accounts.get(accountId) ?? emptyAccount(accountId);
        account.folders.push({
            localPath: trimTrailingSeparator(draft.localPath),
            targetPath: normaliseRemotePath(draft.targetPath ?? '/'),
            accountId,
            // "off" and an absent key both mean the folder is fully downloaded.
            virtualFiles: Boolean(draft.virtualFilesMode) && draft.virtualFilesMode !== 'off',
        });
        accounts.set(accountId, account);
    }

    // An account with no URL is a half-written config entry, not an account.
    return [...accounts.values()]
        .filter((account) => Boolean(account.url))
        .map((account) => ({ ...account, folders: sortFolders(account.folders) }));
}

function emptyAccount(id: string): NextcloudAccount {
    return { id, url: '', user: '', folders: [] };
}

function applyAccountField(account: NextcloudAccount, field: string, value: string): void {
    switch (field) {
        case 'url':
            account.url = value.replace(/\/+$/, '');
            break;
        case 'user':
        case 'webflow_user':
        case 'http_user':
            if (!account.user) account.user = value;
            break;
        case 'dav_user':
            account.davUser = value;
            break;
        case 'displayName':
            account.displayName = value;
            break;
        default:
            break;
    }
}

function applyFolderField(draft: FolderDraft, field: string, value: string): void {
    switch (field) {
        case 'localPath':
            draft.localPath = value;
            break;
        case 'targetPath':
            draft.targetPath = value;
            break;
        case 'virtualFilesMode':
            draft.virtualFilesMode = value;
            break;
        default:
            break;
    }
}

/**
 * Longest local path first.
 *
 * Nested sync folders are legal — someone syncs `~/Nextcloud` and also
 * `~/Nextcloud/Projects` as its own pair with a different target — and
 * resolving a file against the shortest match first would file it under the
 * wrong account. Sorting once here means every lookup is a first-match.
 */
function sortFolders(folders: NextcloudSyncFolder[]): NextcloudSyncFolder[] {
    return [...folders].sort((a, b) => b.localPath.length - a.localPath.length);
}
