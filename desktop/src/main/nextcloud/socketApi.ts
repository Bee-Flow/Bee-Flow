/**
 * A client for the Nextcloud desktop client's socket API.
 *
 * What this buys, over reading the config file alone:
 *   - **live sync state** for a file ("still uploading", "error", "excluded"),
 *     so Bee Flow can say "that file has not finished syncing yet" instead of
 *     handing the server a WebDAV path that 404s;
 *   - **the client's own share dialog**, which is the only correct way to
 *     create a share — it honours the instance's expiry and password policy,
 *     which a share made through the API behind the user's back would not;
 *   - **private links**, which need the file id that only the client knows.
 *
 * Everything here degrades to nothing. If the socket is absent — the client is
 * not running, or it moved, or this is a Flatpak that does not expose it — the
 * bridge keeps working with the config file and the features above turn off.
 * They are never load-bearing.
 */

import { LineBuffer, formatCommand, normaliseSyncState, type SocketMessage } from './socketProtocol.ts';
import type { NextcloudSyncState } from '../../shared/types.ts';

/** The subset of `net.Socket` used here, so tests can supply their own. */
export interface SocketLike {
    write(data: string): unknown;
    destroy(): unknown;
    on(event: 'data', listener: (chunk: Buffer | string) => void): unknown;
    on(event: 'error', listener: (error: Error) => void): unknown;
    on(event: 'close', listener: () => void): unknown;
}

/** Opens a connection to one candidate path, or rejects. */
export type SocketConnector = (path: string) => Promise<SocketLike>;

export interface SocketApiOptions {
    connect: SocketConnector;
    /** How long to wait for the handshake and for a status reply. */
    timeoutMs?: number;
    onWarning?: (message: string) => void;
    /** Pushed status updates, including ones nobody asked for. */
    onStatus?: (path: string, state: NextcloudSyncState) => void;
    /** Called when the connection drops, so the bridge can update its status. */
    onDisconnect?: () => void;
}

interface PendingStatus {
    path: string;
    resolve: (state: NextcloudSyncState) => void;
    timer: ReturnType<typeof setTimeout>;
}

export const DEFAULT_SOCKET_TIMEOUT_MS = 2_000;

export class NextcloudSocketApi {
    private readonly options: SocketApiOptions;
    private readonly buffer = new LineBuffer();
    private socket: SocketLike | null = null;
    private pending: PendingStatus[] = [];
    private registered = new Set<string>();

    /** Which candidate answered, once one has. */
    socketPath: string | null = null;
    /** The client's own version, from its VERSION reply. */
    clientVersion: string | null = null;

    constructor(options: SocketApiOptions) {
        this.options = options;
    }

    get connected(): boolean {
        return this.socket !== null;
    }

    /**
     * Try each candidate in turn and keep the first that answers.
     *
     * "Answers" means more than "connected": on Windows a stale named pipe and
     * on Linux a leftover socket file both accept a connection and then say
     * nothing. The handshake below asks for VERSION and requires a reply, so a
     * dead socket is rejected in a couple of seconds instead of becoming a
     * connection that silently never works.
     */
    async connectAny(candidates: readonly string[]): Promise<boolean> {
        for (const candidate of candidates) {
            try {
                const socket = await this.options.connect(candidate);
                const ok = await this.handshake(socket);
                if (ok) {
                    this.socketPath = candidate;
                    return true;
                }
                socket.destroy();
            } catch (error) {
                // Every candidate but one is expected to fail; that is what a
                // candidate list is. Only say so at debug volume.
                this.options.onWarning?.(`socket ${candidate}: ${describe(error)}`);
            }
        }
        return false;
    }

    /**
     * Tell the client which folders we care about.
     *
     * The client only pushes status for registered paths — this is how its own
     * file-manager extensions work — so without this, status queries answer
     * NOP for files that are perfectly well synced.
     */
    registerPaths(paths: readonly string[]): void {
        for (const path of paths) {
            if (this.registered.has(path)) continue;
            this.registered.add(path);
            this.send(formatCommand('REGISTER_PATH', path));
        }
    }

    /** Ask for one file's sync state. Resolves UNKNOWN if the client is quiet. */
    async fileStatus(localPath: string): Promise<NextcloudSyncState> {
        if (!this.socket) return 'UNKNOWN';
        return new Promise<NextcloudSyncState>((resolve) => {
            const timer = setTimeout(() => {
                this.pending = this.pending.filter((entry) => entry.timer !== timer);
                resolve('UNKNOWN');
            }, this.options.timeoutMs ?? DEFAULT_SOCKET_TIMEOUT_MS);
            this.pending.push({ path: localPath, resolve, timer });
            this.send(formatCommand('RETRIEVE_FILE_STATUS', localPath));
        });
    }

    /**
     * Open the client's share dialog for a file.
     *
     * Fire and forget: the reply is a window on the user's screen, not a
     * message on this socket.
     */
    share(localPath: string): boolean {
        return this.send(formatCommand('SHARE', localPath));
    }

    /** Ask the client to put the file's permanent link on the clipboard. */
    copyPrivateLink(localPath: string): boolean {
        return this.send(formatCommand('COPY_PRIVATE_LINK', localPath));
    }

    close(): void {
        for (const entry of this.pending) {
            clearTimeout(entry.timer);
            entry.resolve('UNKNOWN');
        }
        this.pending = [];
        this.registered.clear();
        this.buffer.reset();
        this.socket?.destroy();
        this.socket = null;
        this.socketPath = null;
    }

    private send(line: string): boolean {
        if (!this.socket) return false;
        try {
            this.socket.write(line);
            return true;
        } catch (error) {
            this.options.onWarning?.(`could not write to the Nextcloud socket: ${describe(error)}`);
            this.handleClose();
            return false;
        }
    }

    private async handshake(socket: SocketLike): Promise<boolean> {
        return new Promise<boolean>((resolve) => {
            let settled = false;
            const finish = (ok: boolean) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                resolve(ok);
            };

            const timer = setTimeout(() => finish(false), this.options.timeoutMs ?? DEFAULT_SOCKET_TIMEOUT_MS);

            socket.on('data', (chunk) => {
                const messages = this.buffer.push(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
                for (const message of messages) {
                    if (!settled && message.command === 'VERSION') {
                        this.clientVersion = message.args[0] ?? null;
                        this.socket = socket;
                        finish(true);
                        continue;
                    }
                    this.handleMessage(message);
                }
            });
            socket.on('error', (error) => {
                this.options.onWarning?.(`Nextcloud socket error: ${error.message}`);
                finish(false);
                this.handleClose();
            });
            socket.on('close', () => {
                finish(false);
                this.handleClose();
            });

            try {
                socket.write(formatCommand('VERSION'));
            } catch (error) {
                this.options.onWarning?.(`could not greet the Nextcloud socket: ${describe(error)}`);
                finish(false);
            }
        });
    }

    private handleMessage(message: SocketMessage): void {
        if (message.command !== 'STATUS') return;
        const state = normaliseSyncState(message.args[0] ?? '');
        const path = message.args[1] ?? '';
        if (!path) return;

        // The client answers a query and also pushes unsolicited updates on the
        // same channel, so a reply is "the first STATUS naming this path".
        const index = this.pending.findIndex((entry) => entry.path === path);
        if (index !== -1) {
            const [entry] = this.pending.splice(index, 1);
            if (entry) {
                clearTimeout(entry.timer);
                entry.resolve(state);
            }
        }
        this.options.onStatus?.(path, state);
    }

    private handleClose(): void {
        if (!this.socket && !this.socketPath) return;
        this.socket = null;
        this.socketPath = null;
        this.registered.clear();
        this.buffer.reset();
        for (const entry of this.pending) {
            clearTimeout(entry.timer);
            entry.resolve('UNKNOWN');
        }
        this.pending = [];
        this.options.onDisconnect?.();
    }
}

function describe(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
