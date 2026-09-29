/**
 * The Nextcloud bridge — everything above assembled into one object the rest
 * of the app talks to.
 *
 * The shape of the integration, in one place:
 *
 *   config file  →  which accounts exist, which folders sync where  (always)
 *   socket       →  live sync state, the client's share dialog      (when running)
 *   Login Flow   →  an app password for the Bee Flow server         (on request)
 *   watchers     →  folders that keep a knowledge base current      (opt in)
 *
 * The first line works with the Nextcloud client merely installed. The rest are
 * additions, and each one is allowed to be missing.
 */

import { promises as fsPromises } from 'node:fs';
import * as net from 'node:net';
import * as path from 'node:path';

import type {
    DesktopSettings,
    NextcloudAccount,
    NextcloudFileRef,
    NextcloudStatus,
    NextcloudSyncState,
    WatchedFileEvent,
    WatchedFolder,
} from '../../shared/types.ts';
import { accountsFrom, configCandidates, parseIni } from './clientConfig.ts';
import { defaultSaveFolder, isInside, resolveLocalPath, toPosix } from './paths.ts';
import { NextcloudSocketApi, type SocketConnector, type SocketLike } from './socketApi.ts';
import { isNamedPipe, socketCandidates } from './socketPath.ts';
import { FolderWatcher, type WatcherFactory } from './watcher.ts';
import { pollLoginFlow, startLoginFlow, type FetchLike, type LoginFlowCredential } from './loginFlow.ts';

export interface BridgeIo {
    readFile(file: string, encoding: 'utf8'): Promise<string>;
    writeFile(file: string, data: string | Uint8Array): Promise<void>;
    mkdir(dir: string, options: { recursive: true }): Promise<string | undefined>;
    stat(file: string): Promise<{ isDirectory(): boolean }>;
    access(file: string): Promise<void>;
    /** Where a path really leads, symlinks followed. Optional so test doubles can leave it out. */
    realpath?(file: string): Promise<string>;
}

const realIo: BridgeIo = {
    readFile: (file, encoding) => fsPromises.readFile(file, encoding),
    writeFile: (file, data) => fsPromises.writeFile(file, data),
    mkdir: (dir, options) => fsPromises.mkdir(dir, options),
    stat: (file) => fsPromises.stat(file),
    access: (file) => fsPromises.access(file),
    realpath: (file) => fsPromises.realpath(file),
};

/** The default connector: a Unix socket, or a Windows named pipe by name. */
const realConnect: SocketConnector = (candidate) =>
    new Promise<SocketLike>((resolve, reject) => {
        const socket = net.createConnection(isNamedPipe(candidate) ? { path: candidate } : { path: candidate });
        socket.setEncoding('utf8');
        const onError = (error: Error) => {
            socket.destroy();
            reject(error);
        };
        socket.once('error', onError);
        socket.once('connect', () => {
            socket.removeListener('error', onError);
            resolve(socket as unknown as SocketLike);
        });
    });

export interface BridgeOptions {
    settings: () => DesktopSettings;
    io?: BridgeIo;
    connect?: SocketConnector;
    fetch?: FetchLike;
    createWatcher?: WatcherFactory;
    env?: NodeJS.ProcessEnv;
    platform?: NodeJS.Platform;
    home?: string;
    onStatusChanged?: (status: NextcloudStatus) => void;
    onWatchedFile?: (event: WatchedFileEvent) => void;
    onWarning?: (message: string) => void;
}

export class NextcloudBridge {
    private readonly options: BridgeOptions;
    private readonly io: BridgeIo;
    private readonly platform: NodeJS.Platform;
    private readonly env: NodeJS.ProcessEnv;
    private readonly home: string;
    private readonly socket: NextcloudSocketApi;
    private readonly watcher: FolderWatcher | null;

    private current: NextcloudStatus = { installed: false, running: false, accounts: [] };
    private loginAbort: AbortController | null = null;

    constructor(options: BridgeOptions) {
        this.options = options;
        this.io = options.io ?? realIo;
        this.platform = options.platform ?? process.platform;
        this.env = options.env ?? process.env;
        this.home = options.home ?? this.env.HOME ?? this.env.USERPROFILE ?? '';

        this.socket = new NextcloudSocketApi({
            connect: options.connect ?? realConnect,
            onWarning: (message) => this.warn(message),
            onDisconnect: () => {
                this.current = { ...this.current, running: false };
                delete this.current.socketPath;
                this.options.onStatusChanged?.(this.current);
            },
        });

        this.watcher = options.createWatcher
            ? new FolderWatcher({
                  createWatcher: options.createWatcher,
                  onFile: (event) => this.options.onWatchedFile?.(event),
                  onWarning: (message) => this.warn(message),
                  accounts: () => this.current.accounts,
                  platform: this.platform,
              })
            : null;
    }

    status(): NextcloudStatus {
        return this.current;
    }

    accounts(): readonly NextcloudAccount[] {
        return this.current.accounts;
    }

    /** Origins of every account, for the navigation policy's login allowance. */
    accountOrigins(): string[] {
        return this.current.accounts.map((account) => account.url).filter(Boolean);
    }

    /**
     * Re-read the client's config and, if it is running, reconnect the socket.
     *
     * Called at startup, when the settings change, and when the user presses
     * the refresh button after installing Nextcloud without restarting Bee Flow.
     */
    async refresh(): Promise<NextcloudStatus> {
        const settings = this.options.settings();
        if (!settings.nextcloud.enabled) {
            this.socket.close();
            this.current = { installed: false, running: false, accounts: [] };
            this.options.onStatusChanged?.(this.current);
            return this.current;
        }

        const found = await this.readConfig(settings.nextcloud.configPath);
        const status: NextcloudStatus = {
            installed: found !== null,
            running: false,
            accounts: found?.accounts ?? [],
        };
        if (found) status.configPath = found.path;
        if (!found) {
            status.error =
                'No Nextcloud desktop client configuration found. Install the Nextcloud desktop app and sign in, or point Bee Flow at the configuration file in Settings.';
        }

        // The socket is worth trying even with no accounts parsed: a client that
        // is running can still answer, and a config we could not read is
        // exactly when that matters.
        const connected = await this.connectSocket(settings.nextcloud.socketPath);
        status.running = connected;
        if (connected && this.socket.socketPath) status.socketPath = this.socket.socketPath;

        this.current = status;

        if (connected) {
            const roots = status.accounts.flatMap((account) => account.folders.map((folder) => folder.localPath));
            this.socket.registerPaths(roots);
        }

        await this.watcher?.sync(settings.nextcloud.watchedFolders);
        this.options.onStatusChanged?.(status);
        return status;
    }

    /** Re-arm the watchers after a settings change, without re-reading the config. */
    async syncWatchers(folders: readonly WatchedFolder[]): Promise<void> {
        await this.watcher?.sync(folders);
    }

    /**
     * Resolve local paths to Nextcloud references, with live sync state when
     * the client is running.
     */
    async resolve(paths: readonly string[]): Promise<NextcloudFileRef[]> {
        const out: NextcloudFileRef[] = [];
        for (const localPath of paths) {
            const isDirectory = await this.isDirectory(localPath);
            const reference = resolveLocalPath(localPath, this.current.accounts, { platform: this.platform, isDirectory });
            if (!reference) continue;
            if (this.socket.connected) {
                const state = await this.socket.fileStatus(reference.localPath);
                if (state !== 'UNKNOWN') reference.syncState = state;
            }
            out.push(reference);
        }
        return out;
    }

    async syncStateOf(localPath: string): Promise<NextcloudSyncState> {
        if (!this.socket.connected) return 'UNKNOWN';
        return this.socket.fileStatus(toPosix(localPath));
    }

    /**
     * Ask the Nextcloud client to open its own share dialog.
     *
     * Deliberately not "create a share through the API and hand back a URL":
     * the instance's sharing policy — expiry dates, mandatory passwords,
     * whether public links are allowed at all — lives in that dialog. Making a
     * share behind it would quietly route around an administrator's settings.
     */
    share(localPath: string): boolean {
        return this.socket.share(toPosix(localPath));
    }

    copyPrivateLink(localPath: string): boolean {
        return this.socket.copyPrivateLink(toPosix(localPath));
    }

    /**
     * Write a file into the Nextcloud sync folder, where the client picks it up.
     *
     * The simplest possible "send this to Nextcloud": no upload, no API call,
     * no second copy — the bytes land in a synced folder and Nextcloud does
     * what it already does.
     */
    async save(input: { fileName: string; data: string | Uint8Array; folder?: string }): Promise<NextcloudFileRef | null> {
        const settings = this.options.settings();
        const target = input.folder || settings.nextcloud.saveFolder || defaultSaveFolder(this.current.accounts);
        if (!target) {
            this.warn('nowhere to save: no Nextcloud sync folder is known');
            return null;
        }

        const name = safeFileName(input.fileName);
        if (!name) {
            this.warn(`refusing to save a file called "${input.fileName}"`);
            return null;
        }

        // A caller-supplied folder is only honoured inside a sync folder. The
        // renderer is the server's own page, and "save this file" must not
        // become "write anywhere on this machine" — not by `..`, not by a
        // symlink inside the sync folder that points out of it.
        if (input.folder) {
            if (toPosix(input.folder).split('/').includes('..') || !this.isInsideAnySyncFolder(input.folder)) {
                this.warn(`refusing to save outside the Nextcloud sync folders: ${input.folder}`);
                return null;
            }
        }

        await this.io.mkdir(target, { recursive: true });
        if (input.folder && !(await this.stillInsideAfterSymlinks(target))) {
            this.warn(`refusing to save through a link that leads out of the Nextcloud sync folders: ${input.folder}`);
            return null;
        }
        const destination = await this.uniquePath(path.posix.join(toPosix(target), name));
        if (input.folder && !this.isInsideAnySyncFolder(destination)) {
            this.warn(`refusing to save outside the Nextcloud sync folders: ${destination}`);
            return null;
        }
        await this.io.writeFile(destination, input.data);

        return resolveLocalPath(destination, this.current.accounts, { platform: this.platform, isDirectory: false });
    }

    /**
     * Run Login Flow v2 and return the credential.
     *
     * The caller (ipc/handlers.ts) opens `loginUrl` in the system browser and
     * hands the result to the Bee Flow server. Nothing here logs the password,
     * and the bridge does not keep a copy.
     */
    async login(
        serverUrl: string,
        openExternal: (url: string) => Promise<void> | void,
    ): Promise<LoginFlowCredential> {
        this.cancelLogin();
        const controller = new AbortController();
        this.loginAbort = controller;

        const fetchImpl = this.options.fetch ?? (globalThis.fetch as unknown as FetchLike);
        try {
            const start = await startLoginFlow(serverUrl, { fetch: fetchImpl });
            await openExternal(start.loginUrl);
            return await pollLoginFlow(start, { fetch: fetchImpl, signal: controller.signal });
        } finally {
            if (this.loginAbort === controller) this.loginAbort = null;
        }
    }

    cancelLogin(): void {
        this.loginAbort?.abort();
        this.loginAbort = null;
    }

    async dispose(): Promise<void> {
        this.cancelLogin();
        this.socket.close();
        await this.watcher?.stopAll();
    }

    /** Is this path inside one of the sync folders? Used to bound writes. */
    /** Is the real location of `directory` (symlinks followed) inside the real location of a sync folder? */
    private async stillInsideAfterSymlinks(directory: string): Promise<boolean> {
        const realpath = this.io.realpath;
        if (!realpath) return true;
        const real = await realpath(directory).catch(() => null);
        if (!real) return false;
        for (const account of this.current.accounts) {
            for (const folder of account.folders) {
                const root = await realpath(folder.localPath).catch(() => folder.localPath);
                if (isInside(root, real, this.platform)) return true;
            }
        }
        return false;
    }

    isInsideAnySyncFolder(candidate: string): boolean {
        return this.current.accounts.some((account) =>
            account.folders.some((folder) => isInside(folder.localPath, candidate, this.platform)),
        );
    }

    private async readConfig(override: string): Promise<{ path: string; accounts: NextcloudAccount[] } | null> {
        const candidates = override ? [override] : configCandidates(this.env, this.platform, this.home);
        for (const candidate of candidates) {
            try {
                const text = await this.io.readFile(candidate, 'utf8');
                return { path: candidate, accounts: accountsFrom(parseIni(text)) };
            } catch (error) {
                const code = (error as NodeJS.ErrnoException)?.code;
                // Not being there is the expected outcome for all but one
                // candidate. Anything else is worth a line in the log.
                if (code !== 'ENOENT' && code !== 'ENOTDIR') {
                    this.warn(`could not read ${candidate}: ${describe(error)}`);
                }
            }
        }
        return null;
    }

    private async connectSocket(override: string): Promise<boolean> {
        if (this.socket.connected) return true;
        const candidates = override ? [override] : socketCandidates(this.env, this.platform, this.home);
        return this.socket.connectAny(candidates);
    }

    private async isDirectory(candidate: string): Promise<boolean> {
        try {
            return (await this.io.stat(candidate)).isDirectory();
        } catch {
            return false;
        }
    }

    /** Never overwrite: "rapport.pdf" becomes "rapport (2).pdf". */
    private async uniquePath(candidate: string): Promise<string> {
        const extension = path.posix.extname(candidate);
        const stem = candidate.slice(0, candidate.length - extension.length);
        for (let attempt = 1; attempt < 100; attempt += 1) {
            const target = attempt === 1 ? candidate : `${stem} (${attempt})${extension}`;
            try {
                await this.io.access(target);
            } catch {
                return target;
            }
        }
        return `${stem} (${Date.now()})${extension}`;
    }

    private warn(message: string): void {
        if (this.options.onWarning) this.options.onWarning(message);
        else console.warn(`[Nextcloud] ${message}`);
    }
}

/**
 * Reduce a proposed file name to something that can only land in the folder it
 * was meant for.
 *
 * The name comes from the server's page — a chat message's "save this" button —
 * so `../../.ssh/authorized_keys` is exactly the input to plan for.
 */
export function safeFileName(raw: string): string {
    const base = String(raw ?? '')
        .replace(/\\/g, '/')
        .split('/')
        .pop()
        ?.trim();
    if (!base || base === '.' || base === '..') return '';
    // Reserved on Windows, awkward everywhere. Control characters are exactly
    // what this is here to strip: they are legal in a POSIX name and produce a
    // file Windows cannot open.
    // eslint-disable-next-line no-control-regex
    const cleaned = base.replace(/[<>:"|?*\u0000-\u001f]/g, '_').replace(/[. ]+$/, '');
    if (!cleaned) return '';
    if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(cleaned)) return `_${cleaned}`;
    return cleaned.slice(0, 200);
}

function describe(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
