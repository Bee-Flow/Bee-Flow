/**
 * The IPC contract.
 *
 * Every channel the preload exposes is named here once, so the main process
 * and the two renderers (the server's SPA, and the local shell pages) cannot
 * drift. A channel that is not in this file does not exist: the preload
 * registers exactly these and nothing dynamic, which is what keeps the bridge
 * a bridge rather than an open door into Node.
 */

import type {
    AppDiagnostics,
    Platform,
    DesktopSettings,
    NextcloudFileRef,
    NextcloudStatus,
    ServerProbeResult,
    WatchedFileEvent,
    WatchedFolder,
} from './types.ts';

/** Channels the renderer invokes and awaits a reply on. */
/**
 * The renderer command-line switch that carries the app version to the
 * preload (see hardenedWebPreferences). A sandboxed preload cannot read
 * anything from the main process synchronously, and `version` is a property.
 */
export const VERSION_ARGUMENT = '--beeflow-version=';

export const INVOKE = {
    // ── App ──
    diagnostics: 'app:diagnostics',
    openExternal: 'app:open-external',
    openSettings: 'app:open-settings',
    showItemInFolder: 'app:show-item-in-folder',
    relaunch: 'app:relaunch',

    // ── Settings ──
    settingsGet: 'settings:get',
    settingsPatch: 'settings:patch',

    // ── Server ──
    serverGet: 'server:get',
    serverProbe: 'server:probe',
    serverSet: 'server:set',
    serverForget: 'server:forget',
    serverChoose: 'server:choose',

    // ── Updates ──
    updateCheck: 'update:check',
    updateInstall: 'update:install',

    // ── Nextcloud ──
    ncStatus: 'nextcloud:status',
    ncRefresh: 'nextcloud:refresh',
    ncResolve: 'nextcloud:resolve',
    ncPickFiles: 'nextcloud:pick-files',
    ncShare: 'nextcloud:share',
    ncReveal: 'nextcloud:reveal',
    ncOpenInNextcloud: 'nextcloud:open-in-nextcloud',
    ncSave: 'nextcloud:save',
    ncLoginStart: 'nextcloud:login-start',
    ncLoginCancel: 'nextcloud:login-cancel',
    ncWatchList: 'nextcloud:watch-list',
    ncWatchAdd: 'nextcloud:watch-add',
    ncWatchRemove: 'nextcloud:watch-remove',
    ncWatchUpdate: 'nextcloud:watch-update',

    // ── Notifications / badge ──
    notify: 'shell:notify',
    setBadge: 'shell:set-badge',
} as const;

/** Channels the main process pushes to the renderer, unprompted. */
export const EVENT = {
    settingsChanged: 'settings:changed',
    serverChanged: 'server:changed',
    ncStatusChanged: 'nextcloud:status-changed',
    watchedFile: 'nextcloud:watched-file',
    updateState: 'update:state',
    deepLink: 'app:deep-link',
    /** The shell asks the SPA to act: new chat, quick ask, focus search. */
    command: 'app:command',
} as const;

export type InvokeChannel = (typeof INVOKE)[keyof typeof INVOKE];
export type EventChannel = (typeof EVENT)[keyof typeof EVENT];

/** A command the native chrome (menu, tray, shortcut) sends to the SPA. */
export type AppCommand =
    | { kind: 'new-chat' }
    | { kind: 'focus-search' }
    | { kind: 'quick-ask'; text: string }
    | { kind: 'attach-files'; files: NextcloudFileRef[] };

/** Where an update currently stands, as the renderer sees it. */
export type UpdateState =
    | { status: 'idle' }
    | { status: 'checking' }
    | { status: 'available'; version: string; notes?: string }
    | { status: 'downloading'; percent: number }
    | { status: 'ready'; version: string }
    | { status: 'unsupported'; reason: string }
    | { status: 'error'; message: string };

/** Result of a Nextcloud Login Flow v2 round trip. */
export type NextcloudLoginResult =
    | { ok: true; server: string; loginName: string; /** True when the app password was handed to the Bee Flow server. */ storedOnServer: boolean }
    | { ok: false; error: string };

/**
 * The typed surface `window.beeflow` exposes. The preload builds exactly this
 * object; the shell UI and any SPA code that wants desktop features consume it
 * through `window.beeflow?.…`, so a browser tab (where it is undefined) keeps
 * working unchanged.
 */
export interface BeeflowBridge {
    /** Always 'desktop'. Lets the SPA feature-detect without sniffing the UA. */
    readonly client: 'desktop';
    readonly platform: Platform;
    readonly version: string;

    diagnostics(): Promise<AppDiagnostics>;
    openExternal(url: string): Promise<boolean>;
    /** Open this app's own settings window. */
    openSettings(): Promise<void>;
    showItemInFolder(path: string): Promise<boolean>;
    relaunch(): Promise<void>;

    settings: {
        get(): Promise<DesktopSettings>;
        patch(patch: DeepPartial<DesktopSettings>): Promise<DesktopSettings>;
        onChanged(listener: (settings: DesktopSettings) => void): Unsubscribe;
    };

    server: {
        get(): Promise<{ url: string; recent: string[] }>;
        probe(url: string): Promise<ServerProbeResult>;
        set(url: string): Promise<ServerProbeResult>;
        forget(url: string): Promise<void>;
        /** Open the server picker in the workspace window. */
        choose(): Promise<void>;
        onChanged(listener: (url: string) => void): Unsubscribe;
    };

    updates: {
        check(): Promise<UpdateState>;
        install(): Promise<void>;
        onState(listener: (state: UpdateState) => void): Unsubscribe;
    };

    nextcloud: {
        status(): Promise<NextcloudStatus>;
        refresh(): Promise<NextcloudStatus>;
        /** Resolve local paths against the sync folders. Unknown paths are dropped. */
        resolve(paths: string[]): Promise<NextcloudFileRef[]>;
        /** Open a native picker rooted at a sync folder. */
        pickFiles(options?: { accountId?: string; multiple?: boolean }): Promise<NextcloudFileRef[]>;
        /**
         * Open the Nextcloud client's own share dialog for a file.
         *
         * Returns whether the client took the request — false means it is not
         * running, or the file is not in a sync folder. There is no URL to
         * return: what kind of share this becomes is the user's choice, made in
         * that dialog under the instance's own sharing policy.
         */
        share(localPath: string): Promise<boolean>;
        reveal(localPath: string): Promise<boolean>;
        openInNextcloud(localPath: string): Promise<boolean>;
        /** Write bytes into the sync folder; returns the resolved reference. */
        save(input: { fileName: string; data: ArrayBuffer | Uint8Array | string; folder?: string; encoding?: 'utf8' | 'base64' }): Promise<NextcloudFileRef | null>;
        login(server?: string): Promise<NextcloudLoginResult>;
        cancelLogin(): Promise<void>;
        watched: {
            list(): Promise<WatchedFolder[]>;
            add(input: { path?: string; knowledgeBaseId: string; label?: string; recursive?: boolean }): Promise<WatchedFolder | null>;
            update(id: string, patch: Partial<Omit<WatchedFolder, 'id'>>): Promise<WatchedFolder | null>;
            remove(id: string): Promise<void>;
            onFile(listener: (event: WatchedFileEvent) => void): Unsubscribe;
        };
        onStatusChanged(listener: (status: NextcloudStatus) => void): Unsubscribe;
    };

    /**
     * The local paths behind dropped or picked `File` objects.
     *
     * Chromium stopped exposing `File.path` to renderers, and this is the
     * supported replacement. It is the first step of the whole drag-and-drop
     * story: paths in, `nextcloud.resolve` next, and what comes back is a
     * WebDAV reference the server can read rather than a second copy of the
     * file. A path that is not in a sync folder simply does not come back, and
     * the page uploads it the ordinary way.
     */
    filePathsOf(files: ArrayLike<File>): string[];

    notify(input: { title: string; body: string; silent?: boolean; deepLink?: string }): Promise<void>;
    setBadge(count: number): Promise<void>;

    onCommand(listener: (command: AppCommand) => void): Unsubscribe;
    onDeepLink(listener: (url: string) => void): Unsubscribe;
}

export type Unsubscribe = () => void;

export type DeepPartial<T> = {
    [K in keyof T]?: T[K] extends (infer U)[] ? U[] : T[K] extends object ? DeepPartial<T[K]> : T[K];
};
