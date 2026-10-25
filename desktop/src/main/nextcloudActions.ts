/**
 * The Nextcloud side of the app: the last known status, pairing through Login
 * Flow v2, opening the sync folder. No electron import; the window session,
 * the browser, the dialog and the tray come in through the host.
 */

import { EVENT } from '../shared/ipc.ts';
import type { NextcloudStatus, WatchedFileEvent } from '../shared/types.ts';
import { noNextcloudFolder } from './dialogs.ts';
import type { LoginFlowCredential } from './nextcloud/loginFlow.ts';
import { pairingTarget, pairNextcloud, type PairingLog, type PairingResult, type SessionFetch, sendAppPasswordToServer } from './nextcloud/pairing.ts';
import { nextcloudSummary } from './nextcloud/summary.ts';

/** The part of NextcloudBridge these flows use. */
export interface BridgeLike {
    refresh(): Promise<NextcloudStatus>;
    login(serverUrl: string, openExternal: (url: string) => Promise<void> | void): Promise<LoginFlowCredential>;
}

export interface NextcloudHost {
    log: PairingLog & { debug(tag: string, message: string): void };
    bridge: BridgeLike;
    /** Keep the app password in the OS keyring; false when that is not possible. */
    storeAppPassword(appPassword: string): Promise<boolean>;
    serverUrl(): string;
    /** The main window's session fetch; null when there is no live main window. */
    mainSessionFetch(): SessionFetch | null;
    openExternal(url: string): Promise<void>;
    openPath(path: string): Promise<unknown>;
    /** Informational: nothing waits for it to close. */
    showMessage(message: ReturnType<typeof noNextcloudFolder>): void;
    statusChanged(): void;
    broadcast(channel: string, payload: unknown): void;
}

export class NextcloudActions {
    private readonly host: NextcloudHost;
    private current: NextcloudStatus = { installed: false, running: false, accounts: [] };

    constructor(host: NextcloudHost) {
        this.host = host;
    }

    get status(): NextcloudStatus {
        return this.current;
    }

    async refresh(): Promise<NextcloudStatus> {
        const status = await this.host.bridge.refresh();
        this.host.log.info('Nextcloud', nextcloudSummary(status));
        return status;
    }

    onStatus(status: NextcloudStatus): void {
        this.current = status;
        this.host.statusChanged();
        this.host.broadcast(EVENT.ncStatusChanged, status);
    }

    onWatchedFile(event: WatchedFileEvent): void {
        this.host.log.debug('Nextcloud', `watched ${event.kind}: ${event.localPath}`);
        this.host.broadcast(EVENT.watchedFile, event);
    }

    async openFolder(): Promise<void> {
        const folder = this.current.accounts[0]?.folders[0]?.localPath;
        if (!folder) {
            this.host.showMessage(noNextcloudFolder(this.current));
            return;
        }
        await this.host.openPath(folder);
    }

    /** Run Login Flow v2 and hand the credential to the Bee Flow server (see nextcloud/pairing.ts). */
    pair(serverUrlHint?: string): Promise<PairingResult> {
        return pairNextcloud(pairingTarget(serverUrlHint, this.current.accounts), {
            login: (target) => this.host.bridge.login(target, (url) => this.host.openExternal(url)),
            persistAppPassword: (appPassword) => this.host.storeAppPassword(appPassword),
            sendToServer: (credential) => this.sendToServer(credential),
            log: this.host.log,
        });
    }

    /** Hand the app password to the user's own Bee Flow server, over the main window's session. */
    private async sendToServer(credential: LoginFlowCredential): Promise<boolean> {
        const base = this.host.serverUrl();
        const sessionFetch = this.host.mainSessionFetch();
        if (!base || !sessionFetch) return false;
        return sendAppPasswordToServer(credential, base, sessionFetch, this.host.log);
    }
}
