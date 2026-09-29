/**
 * The vocabulary shared by the main process, the preload bridge and the local
 * shell UI. Types only — nothing in here runs, so both module systems in this
 * package can import it without either one owning it.
 */

/**
 * The platforms Node reports, spelled out here rather than reached for as
 * `NodeJS.Platform`.
 *
 * This file is imported by the browser-side shell pages as well as by the main
 * process, and those have no @types/node. Repeating the union costs one line
 * and keeps the shared vocabulary free of a Node dependency; it is
 * structurally identical, so values flow between the two without a cast.
 */
export type Platform =
    | 'aix'
    | 'android'
    | 'cygwin'
    | 'darwin'
    | 'freebsd'
    | 'haiku'
    | 'linux'
    | 'netbsd'
    | 'openbsd'
    | 'sunos'
    | 'win32';

/** Where a desktop install points. Empty `url` means "not set up yet". */
export interface ServerConfig {
    /** Origin + optional subpath, no trailing slash. '' until chosen. */
    url: string;
    /** Previously used servers, newest first. Offered on the server picker. */
    recent: string[];
    /**
     * The server's second origin, when it has one: the address its web app
     * sends single sign-on to (SERVER_PUBLIC_HOST, reported by
     * /auth/setup-status). Navigating there stays in the window so a sign-in
     * can finish in the app; nothing else about it is trusted — the bridge and
     * permissions stay on `url`. '' when the server has only one origin.
     */
    apiOrigin: string;
}

/** What a reachability probe of a candidate server found. */
export interface ServerProbeResult {
    ok: boolean;
    /**
     * The server's address as it should be saved: after normalisation, the
     * http fallback and any redirect the server answered with.
     */
    url: string;
    /** HTTP status, when the request completed. */
    status?: number;
    /** `appVersion` from /api/health — the server's build SHA, when it gave one. */
    appVersion?: string;
    /** Round-trip time in milliseconds. */
    durationMs?: number;
    /**
     * Why the probe failed, in words a person can act on. Never the raw error:
     * "certificate has expired" beats "UNABLE_TO_VERIFY_LEAF_SIGNATURE".
     */
    error?: string;
    /** Machine-readable failure class, for UI branching. */
    code?: ServerProbeFailure;
    /** Plain http to another machine: connected, but the page says so. */
    insecure?: boolean;
    /** The server's single sign-on origin, when it differs (see ServerConfig.apiOrigin). */
    apiOrigin?: string;
    /** Checks that could not be completed and did not block the connection. */
    warnings?: string[];
    /** With code 'redirected': where the server sends people instead. */
    redirectTarget?: string;
}

export type ServerProbeFailure =
    | 'invalid-url'
    | 'dns'
    | 'refused'
    | 'timeout'
    | 'tls'
    | 'proxy'
    | 'http-error'
    | 'not-bee-flow'
    /** It answers plain http, and falling back silently is not safe for that host. */
    | 'plain-http'
    /** The API answers but this address serves no web app: the API port of a Docker install. */
    | 'api-port'
    /** The server refuses requests from the address it was reached at (its CORS_ORIGIN). */
    | 'origin-refused'
    /**
     * It sends people to a different address, and that is not a move Bee Flow
     * follows by itself (another host over http, or from https to http). The
     * person can enter the new address; the app will not switch silently.
     */
    | 'redirected'
    | 'offline'
    | 'unknown';

/** One account the Nextcloud desktop client is signed in to. */
export interface NextcloudAccount {
    /** Stable key within the parsed config (the account's section index). */
    id: string;
    /** Base URL of the Nextcloud server, no trailing slash. */
    url: string;
    /** Login name as the desktop client stores it. */
    user: string;
    /** The WebDAV user, when it differs from the login name (e.g. SAML/SSO). */
    davUser?: string;
    /** Display name, when the client recorded one. */
    displayName?: string;
    /** The folders this account keeps in sync, in config order. */
    folders: NextcloudSyncFolder[];
}

/** A local↔remote folder pair the Nextcloud desktop client syncs. */
export interface NextcloudSyncFolder {
    /** Absolute path on this machine, with a trailing separator removed. */
    localPath: string;
    /** Path on the server relative to the user's files root, e.g. '/' or '/Work'. */
    targetPath: string;
    /** Which account this pair belongs to. */
    accountId: string;
    /** True when the client has virtual-files (placeholder) mode on for it. */
    virtualFiles: boolean;
}

/** What the desktop client knows about the Nextcloud client on this machine. */
export interface NextcloudStatus {
    /** True when a config file was found and parsed. */
    installed: boolean;
    /** True when the running client's socket answered. */
    running: boolean;
    /** Where the config was read from, for the settings UI to show. */
    configPath?: string;
    /** Which socket answered, when one did. */
    socketPath?: string;
    accounts: NextcloudAccount[];
    /** Set when discovery ran and could not complete. */
    error?: string;
}

/** A local file resolved against the Nextcloud sync folders. */
export interface NextcloudFileRef {
    /** Absolute local path, as given. */
    localPath: string;
    /** The account the file belongs to. */
    accountId: string;
    /** Server base URL for that account. */
    serverUrl: string;
    /** Path on the server, relative to the user's files root, POSIX separators. */
    remotePath: string;
    /** Direct WebDAV URL for the file. */
    webdavUrl: string;
    /** A URL that opens the file (or its folder) in the Nextcloud web UI. */
    webUrl: string;
    /** True when the path is a directory. */
    isDirectory: boolean;
    /** Sync state, when the desktop client's socket answered. */
    syncState?: NextcloudSyncState;
}

/**
 * The states the Nextcloud desktop client reports over its socket API. `NOP`
 * is the client's own word for "outside any sync folder"; the rest are its
 * status vocabulary, narrowed to what a person needs to be told.
 */
export type NextcloudSyncState = 'OK' | 'SYNC' | 'ERROR' | 'IGNORE' | 'WARN' | 'NEW' | 'NOP' | 'UNKNOWN';

/** A folder the desktop client watches and offers to Bee Flow. */
export interface WatchedFolder {
    /** Stable id so settings survive a path rename. */
    id: string;
    /** Absolute local path. */
    path: string;
    /** Knowledge base to file new documents under, on the Bee Flow server. */
    knowledgeBaseId: string;
    /** Human label for the UI; defaults to the folder name. */
    label: string;
    /** Whether the watcher is currently armed. */
    enabled: boolean;
    /** Include sub-folders. */
    recursive: boolean;
}

/** One file the watcher noticed. Announced to the renderer, never uploaded by it. */
export interface WatchedFileEvent {
    folderId: string;
    knowledgeBaseId: string;
    localPath: string;
    /** Present when the file sits inside a Nextcloud sync folder. */
    remote?: Pick<NextcloudFileRef, 'accountId' | 'serverUrl' | 'remotePath' | 'webdavUrl'>;
    kind: 'added' | 'changed' | 'removed';
    /** Epoch milliseconds. */
    at: number;
}

/** Everything the settings window reads and writes. */
export interface DesktopSettings {
    /** Bumped when the shape changes; `normaliseSettings` migrates forward. */
    version: number;
    server: ServerConfig;
    launch: {
        openAtLogin: boolean;
        startMinimised: boolean;
        /** Closing the last window hides to the tray instead of quitting. */
        closeToTray: boolean;
    };
    shortcuts: {
        /** Accelerator for the quick-ask window. '' disables it. */
        quickAsk: string;
    };
    notifications: {
        enabled: boolean;
        /** Suppress notifications while the main window has focus. */
        onlyWhenUnfocused: boolean;
    };
    updates: {
        /** Check for updates at all. Off for installs managed by a package manager. */
        enabled: boolean;
        /** Download and stage automatically, or only tell the user. */
        automatic: boolean;
        channel: 'stable' | 'beta';
    };
    appearance: {
        theme: 'system' | 'light' | 'dark';
        /** Hide the menu bar on Windows/Linux until Alt is pressed. */
        autoHideMenuBar: boolean;
        zoomLevel: number;
    };
    nextcloud: {
        enabled: boolean;
        /** Override for the client's config file. '' means auto-discover. */
        configPath: string;
        /** Override for the client's socket. '' means auto-discover. */
        socketPath: string;
        /** Where "Save to Nextcloud" drops files. '' means ask every time. */
        saveFolder: string;
        watchedFolders: WatchedFolder[];
    };
}

/** What the About window and the diagnostics page report. */
export interface AppDiagnostics {
    appVersion: string;
    electronVersion: string;
    chromeVersion: string;
    nodeVersion: string;
    platform: Platform;
    arch: string;
    /** How this copy was installed, when it can be told apart. */
    packaging: 'appimage' | 'deb' | 'rpm' | 'pacman' | 'snap' | 'flatpak' | 'msi' | 'nsis' | 'portable' | 'dmg' | 'dev' | 'unknown';
    /** False when the OS keyring is unavailable — credentials are not persisted. */
    secretsAvailable: boolean;
    /**
     * False when this run was started with Chromium's sandbox off
     * (`--no-sandbox`): an AppImage or the tar.gz launcher on a system that
     * restricts user namespaces. Shown, never hidden.
     */
    sandboxed: boolean;
    locale: string;
    logPath: string;
    settingsPath: string;
}
