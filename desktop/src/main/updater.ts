/**
 * Updates — the thin Electron-facing half. The decisions live in
 * updatePolicy.ts, which is testable; this file only does what it is told.
 */

import { autoUpdater } from 'electron-updater';

import type { UpdateState } from '../shared/ipc.ts';
import type { DesktopSettings } from '../shared/types.ts';
import type { Logger } from './logging.ts';
import { channelFor, feedFromEnv, updateCapability, type BuildInfo, type Packaging } from './updatePolicy.ts';

export interface UpdaterOptions {
    packaging: Packaging;
    build?: BuildInfo;
    settings: () => DesktopSettings;
    log: Logger;
    onState: (state: UpdateState) => void;
    env?: NodeJS.ProcessEnv;
}

/** Check once at startup, then daily. A workspace client is left running. */
const CHECK_INTERVAL_MS = 24 * 60 * 60_000;

export class Updater {
    private readonly options: UpdaterOptions;
    private readonly capability: ReturnType<typeof updateCapability>;
    private state: UpdateState = { status: 'idle' };
    private timer: ReturnType<typeof setInterval> | null = null;

    constructor(options: UpdaterOptions) {
        this.options = options;
        this.capability = updateCapability(options.packaging, options.build);

        if (!this.capability.canSelfUpdate) {
            this.state = { status: 'unsupported', reason: this.capability.reason };
            return;
        }

        const feed = feedFromEnv(options.env ?? process.env);
        if (feed) {
            autoUpdater.setFeedURL({ provider: 'generic', url: feed.url });
            options.log.info('Updater', `using the update feed at ${feed.url}`);
        }

        autoUpdater.autoDownload = false; // decided per check, from settings
        autoUpdater.autoInstallOnAppQuit = true;
        autoUpdater.logger = {
            info: (message: unknown) => options.log.info('Updater', String(message)),
            warn: (message: unknown) => options.log.warn('Updater', String(message)),
            error: (message: unknown) => options.log.error('Updater', String(message)),
            debug: (message: unknown) => options.log.debug('Updater', String(message)),
        };

        autoUpdater.on('checking-for-update', () => this.publish({ status: 'checking' }));
        autoUpdater.on('update-available', (info) => {
            this.publish({ status: 'available', version: String(info?.version ?? ''), ...(info?.releaseNotes ? { notes: String(info.releaseNotes) } : {}) });
            if (this.options.settings().updates.automatic) void autoUpdater.downloadUpdate();
        });
        autoUpdater.on('update-not-available', () => this.publish({ status: 'idle' }));
        autoUpdater.on('download-progress', (progress) => this.publish({ status: 'downloading', percent: Math.round(progress?.percent ?? 0) }));
        autoUpdater.on('update-downloaded', (info) => this.publish({ status: 'ready', version: String(info?.version ?? '') }));
        autoUpdater.on('error', (error) => {
            // An update that cannot be checked is a log line, not a dialog: the
            // app works perfectly well on the version it already has.
            this.options.log.warn('Updater', `check failed: ${error?.message ?? String(error)}`);
            this.publish({ status: 'error', message: error?.message ?? 'The update check failed.' });
        });
    }

    current(): UpdateState {
        return this.state;
    }

    /** Start the periodic check, if this install and these settings allow it. */
    start(): void {
        if (!this.capability.canSelfUpdate) return;
        if (!this.options.settings().updates.enabled) return;
        void this.check();
        this.timer = setInterval(() => {
            if (this.options.settings().updates.enabled) void this.check();
        }, CHECK_INTERVAL_MS);
    }

    stop(): void {
        if (this.timer) clearInterval(this.timer);
        this.timer = null;
    }

    async check(): Promise<UpdateState> {
        if (!this.capability.canSelfUpdate) return this.state;
        const choice = this.options.settings().updates.channel;
        autoUpdater.channel = channelFor(choice);
        // Dev builds are published as GitHub *prereleases* (one rolling
        // `desktop-dev` release, replaced on every merge to main). Without this
        // the provider skips them entirely and the beta channel silently
        // reports "up to date" forever — a setting that looks like it works and
        // does not. Stable must stay false, or a beta would be offered to
        // everyone.
        autoUpdater.allowPrerelease = choice === 'beta';
        try {
            await autoUpdater.checkForUpdates();
        } catch (error) {
            this.publish({ status: 'error', message: error instanceof Error ? error.message : String(error) });
        }
        return this.state;
    }

    /** Quit and install a downloaded update. No-op unless one is staged. */
    install(): void {
        if (this.state.status !== 'ready') return;
        autoUpdater.quitAndInstall();
    }

    private publish(state: UpdateState): void {
        this.state = state;
        this.options.onState(state);
    }
}
