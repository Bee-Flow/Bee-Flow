/**
 * The IPC handlers — the only doorway between a renderer and this process.
 *
 * The renderer on the other side of most of these is **the Bee Flow server's
 * own page**. That is the design (see windows/mainWindow.ts), and it means the
 * caller is trusted about as far as the server is: enough to be shown the
 * user's workspace, not enough to be handed the machine.
 *
 * So the handlers split into two groups:
 *
 *   - things the server's page may do, because they are what the integration
 *     is for: resolve a dropped file, ask for its sync state, open the share
 *     dialog, save into the sync folder, raise a notification;
 *   - things only a page THIS APP shipped may do: change which server the
 *     client points at, rewrite settings, relaunch. A server page asking to
 *     repoint the client at another server is either a bug or an attack, and
 *     either way the answer is no.
 *
 * A third kind of page gets nothing at all: whatever else a window can end up
 * showing — an identity provider mid-sign-in, a popup, the server's single
 * sign-on origin. The preload exposes `window.beeflow` to every page it runs
 * in, so the bridge existing is not the permission; the sender's URL is.
 *
 * `senderTrust` (security/policy.ts) draws those lines, on the sender frame's
 * URL rather than on a flag the renderer supplies.
 */

import { BrowserWindow, app, dialog, ipcMain, type IpcMainInvokeEvent } from 'electron';
import * as path from 'node:path';

import { INVOKE } from '../../shared/ipc.ts';
import type { AppDiagnostics, NextcloudFileRef } from '../../shared/types.ts';
import type { DesktopApp } from '../app.ts';
import { settingsForServerPage } from '../config/schema.ts';
import { classifyWindowOpen, senderTrust, type SenderTrust } from '../security/policy.ts';

class RefusedError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'RefusedError';
    }
}

export function registerIpcHandlers(desktop: DesktopApp): void {
    const trustOf = (event: { senderFrame?: { url?: string } | null }): SenderTrust => senderTrust(event.senderFrame?.url ?? '', desktop.policy());
    const isShellSender = (event: IpcMainInvokeEvent) => trustOf(event) === 'shell';

    const handle = (channel: string, handler: (event: IpcMainInvokeEvent, ...args: never[]) => unknown) => {
        ipcMain.handle(channel, async (event, ...args) => {
            try {
                return await handler(event, ...(args as never[]));
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                desktop.log.warn('IPC', `${channel} failed: ${message}`);
                throw error;
            }
        });
    };

    /** Refuse a privileged call that did not come from one of our own pages. */
    const requireShell = (event: IpcMainInvokeEvent, what: string) => {
        if (isShellSender(event)) return;
        desktop.log.warn('IPC', `refused ${what} from ${event.senderFrame?.url ?? 'an unknown frame'}`);
        throw new RefusedError(`${what} can only be done from Bee Flow's own settings window.`);
    };

    /** Refuse a call from anything that is neither our own page nor the workspace. */
    const requireTrusted = (event: IpcMainInvokeEvent, what: string) => {
        if (trustOf(event) !== 'other') return;
        desktop.log.warn('IPC', `refused ${what} from ${event.senderFrame?.url ?? 'an unknown frame'}`);
        throw new RefusedError(`${what} is only available to your Bee Flow workspace.`);
    };

    // ── App ──────────────────────────────────────────────────────────────────

    handle(INVOKE.diagnostics, (event): AppDiagnostics => {
        requireTrusted(event, 'Reading diagnostics');
        const paths = desktop.diagnosticsPaths();
        return {
            appVersion: app.getVersion(),
            electronVersion: process.versions.electron ?? '',
            chromeVersion: process.versions.chrome ?? '',
            nodeVersion: process.versions.node ?? '',
            platform: process.platform,
            arch: process.arch,
            packaging: desktop.packaging,
            secretsAvailable: desktop.secrets.available,
            sandboxed: !app.commandLine.hasSwitch('no-sandbox'),
            locale: app.getLocale(),
            logPath: paths.logPath,
            settingsPath: paths.settingsPath,
        };
    });

    handle(INVOKE.openExternal, async (event, url: string) => {
        requireTrusted(event, 'Opening a link');
        // The same rule the navigation policy uses, so a link cannot get out
        // through IPC that would have been blocked in the window.
        if (classifyWindowOpen(url, desktop.policy()) !== 'external') {
            desktop.log.warn('IPC', `refused to open ${url}`);
            return false;
        }
        return desktop.openExternally(url);
    });

    // Opening a local settings window is harmless whoever asks, and the
    // workspace wants a "Desktop settings" link of its own.
    handle(INVOKE.openSettings, (event) => {
        requireTrusted(event, 'Opening settings');
        desktop.showSettings();
    });

    handle(INVOKE.showItemInFolder, async (event, target: string) => {
        requireTrusted(event, 'Showing a file');
        // Our own pages may also show the app's log and settings files
        // (Settings → About → Show logs); the workspace may not.
        return desktop.revealPath(target, { ownFiles: isShellSender(event) });
    });

    handle(INVOKE.relaunch, (event) => {
        requireShell(event, 'Restarting Bee Flow');
        desktop.relaunch();
    });

    // ── Settings ─────────────────────────────────────────────────────────────

    handle(INVOKE.settingsGet, (event) => {
        requireTrusted(event, 'Reading settings');
        const settings = desktop.settings.get();
        return isShellSender(event) ? settings : settingsForServerPage(settings);
    });

    handle(INVOKE.settingsPatch, async (event, patch: unknown) => {
        requireShell(event, 'Changing settings');
        return desktop.settings.patch(patch);
    });

    // ── Server ───────────────────────────────────────────────────────────────

    handle(INVOKE.serverGet, (event) => {
        requireTrusted(event, 'Reading the server address');
        const server = desktop.settings.get().server;
        // The workspace knows its own address; the other servers this person
        // uses are none of its business.
        return { url: server.url, recent: isShellSender(event) ? server.recent : [] };
    });

    // From the server's page this would be a way to make the desktop request
    // arbitrary addresses on the user's network. Only our pages probe.
    handle(INVOKE.serverProbe, (event, url: string) => {
        requireShell(event, 'Checking a server address');
        return desktop.probe(url);
    });

    handle(INVOKE.serverSet, async (event, url: string) => {
        requireShell(event, 'Changing the Bee Flow server');
        return desktop.setServer(url);
    });

    handle(INVOKE.serverChoose, (event) => {
        requireShell(event, 'Changing the Bee Flow server');
        desktop.chooseServer();
    });

    handle(INVOKE.serverForget, async (event, url: string) => {
        requireShell(event, 'Changing the Bee Flow server');
        await desktop.forgetServer(url);
    });

    // ── Updates ──────────────────────────────────────────────────────────────

    handle(INVOKE.updateCheck, (event) => {
        requireTrusted(event, 'Checking for updates');
        return desktop.checkForUpdates();
    });
    handle(INVOKE.updateInstall, (event) => {
        requireShell(event, 'Installing an update');
        desktop.installUpdate();
    });

    // ── Nextcloud ────────────────────────────────────────────────────────────

    handle(INVOKE.ncStatus, (event) => {
        requireTrusted(event, 'Reading the Nextcloud status');
        return desktop.bridge.status();
    });
    handle(INVOKE.ncRefresh, (event) => {
        requireTrusted(event, 'Refreshing Nextcloud');
        return desktop.refreshNextcloud();
    });

    handle(INVOKE.ncResolve, async (event, paths: string[]) => {
        requireTrusted(event, 'Resolving files');
        if (!Array.isArray(paths)) return [];
        // A cap, because this is reachable from the server's page and each
        // entry costs a stat and possibly a socket round trip.
        return desktop.bridge.resolve(paths.slice(0, 200).filter((value) => typeof value === 'string'));
    });

    handle(INVOKE.ncPickFiles, async (event, options: { accountId?: string; multiple?: boolean } | undefined) => {
        requireTrusted(event, 'Picking files');
        const accounts = desktop.bridge.accounts();
        const account = options?.accountId ? accounts.find((entry) => entry.id === options.accountId) : accounts[0];
        const defaultPath = account?.folders[0]?.localPath;
        const window = BrowserWindow.getFocusedWindow();
        const properties: Array<'openFile' | 'multiSelections'> = ['openFile'];
        if (options?.multiple !== false) properties.push('multiSelections');

        const result = window
            ? await dialog.showOpenDialog(window, { properties, ...(defaultPath ? { defaultPath } : {}) })
            : await dialog.showOpenDialog({ properties, ...(defaultPath ? { defaultPath } : {}) });

        if (result.canceled) return [] as NextcloudFileRef[];
        return desktop.bridge.resolve(result.filePaths);
    });

    handle(INVOKE.ncShare, async (event, localPath: string) => {
        requireTrusted(event, 'Sharing a file');
        if (!desktop.bridge.isInsideAnySyncFolder(localPath)) return false;
        return desktop.bridge.share(localPath);
    });

    handle(INVOKE.ncReveal, async (event, localPath: string) => {
        requireTrusted(event, 'Showing a file');
        return desktop.revealPath(localPath);
    });

    handle(INVOKE.ncOpenInNextcloud, async (event, localPath: string) => {
        requireTrusted(event, 'Opening a file in Nextcloud');
        const [reference] = await desktop.bridge.resolve([localPath]);
        if (!reference) return false;
        return desktop.openExternally(reference.webUrl);
    });

    handle(INVOKE.ncSave, async (event, input: { fileName: string; data: ArrayBuffer | Uint8Array | string; folder?: string; encoding?: 'utf8' | 'base64' }) => {
        requireTrusted(event, 'Saving to Nextcloud');
        const data =
            typeof input?.data === 'string'
                ? input.encoding === 'base64'
                    ? Buffer.from(input.data, 'base64')
                    : input.data
                : toBuffer(input?.data);
        return desktop.bridge.save({
            fileName: String(input?.fileName ?? ''),
            data,
            ...(input?.folder ? { folder: input.folder } : {}),
        });
    });

    handle(INVOKE.ncLoginStart, async (event, server: string | undefined) => {
        requireTrusted(event, 'Signing in to Nextcloud');
        const requested = typeof server === 'string' ? server.trim() : '';
        // A page may start the pairing for a Nextcloud this machine already
        // syncs — that is the ordinary case, and the user has clearly
        // established the relationship. Any OTHER address, asked for by the
        // server's page, gets a dialog first: a sign-in prompt for a host the
        // user has never mentioned is the shape of a phishing attempt.
        if (requested && !isShellSender(event) && !desktop.bridge.accountOrigins().some((origin) => sameHost(origin, requested))) {
            const choice = await dialog.showMessageBox({
                type: 'question',
                buttons: ['Cancel', 'Continue'],
                defaultId: 0,
                cancelId: 0,
                title: 'Sign in to Nextcloud?',
                message: `Bee Flow is asking to sign you in to ${hostOf(requested)}.`,
                detail: 'Only continue if this is your own Nextcloud. Bee Flow will store an app password for it.',
            });
            if (choice.response !== 1) return { ok: false, error: 'Cancelled.' };
        }
        return desktop.pairNextcloud(requested || undefined);
    });

    handle(INVOKE.ncLoginCancel, (event) => {
        requireTrusted(event, 'Cancelling a Nextcloud sign-in');
        return desktop.bridge.cancelLogin();
    });

    handle(INVOKE.ncWatchList, (event) => {
        requireTrusted(event, 'Listing watched folders');
        return desktop.settings.get().nextcloud.watchedFolders;
    });

    handle(INVOKE.ncWatchAdd, async (event, input: { path?: string; knowledgeBaseId: string; label?: string; recursive?: boolean }) => {
        requireTrusted(event, 'Watching a folder');
        const knowledgeBaseId = String(input?.knowledgeBaseId ?? '').trim();
        if (!knowledgeBaseId) throw new RefusedError('A watched folder needs a knowledge base to file its documents under.');

        // A folder is chosen by the user in a native dialog, never supplied by
        // the page: "watch this folder" from a remote origin should not be able
        // to name /etc.
        let folder = typeof input?.path === 'string' ? input.path : '';
        if (!folder || !isShellSender(event)) {
            const window = BrowserWindow.getFocusedWindow();
            const defaultPath = desktop.bridge.accounts()[0]?.folders[0]?.localPath;
            const result = window
                ? await dialog.showOpenDialog(window, { properties: ['openDirectory'], ...(defaultPath ? { defaultPath } : {}) })
                : await dialog.showOpenDialog({ properties: ['openDirectory'], ...(defaultPath ? { defaultPath } : {}) });
            if (result.canceled || !result.filePaths[0]) return null;
            folder = result.filePaths[0];
        }

        const settings = desktop.settings.get();
        const watched = {
            id: `watch-${Date.now().toString(36)}`,
            path: folder,
            knowledgeBaseId,
            label: String(input?.label ?? '').trim() || path.basename(folder),
            enabled: true,
            recursive: input?.recursive !== false,
        };
        const next = await desktop.settings.patch({
            nextcloud: { ...settings.nextcloud, watchedFolders: [...settings.nextcloud.watchedFolders, watched] },
        });
        return next.nextcloud.watchedFolders.find((entry) => entry.id === watched.id) ?? null;
    });

    handle(INVOKE.ncWatchUpdate, async (event, id: string, patch: Record<string, unknown>) => {
        requireShell(event, 'Changing a watched folder');
        const settings = desktop.settings.get();
        const folders = settings.nextcloud.watchedFolders.map((folder) => (folder.id === id ? { ...folder, ...patch, id } : folder));
        const next = await desktop.settings.patch({ nextcloud: { ...settings.nextcloud, watchedFolders: folders } });
        return next.nextcloud.watchedFolders.find((folder) => folder.id === id) ?? null;
    });

    handle(INVOKE.ncWatchRemove, async (event, id: string) => {
        requireShell(event, 'Removing a watched folder');
        const settings = desktop.settings.get();
        await desktop.settings.patch({
            nextcloud: { ...settings.nextcloud, watchedFolders: settings.nextcloud.watchedFolders.filter((folder) => folder.id !== id) },
        });
    });

    // ── Shell services ───────────────────────────────────────────────────────

    handle(INVOKE.notify, (event, input: { title: string; body: string; silent?: boolean; deepLink?: string }) => {
        requireTrusted(event, 'Showing a notification');
        return desktop.notify(input);
    });
    handle(INVOKE.setBadge, (event, count: number) => {
        requireTrusted(event, 'Setting the badge');
        desktop.setBadge(count);
    });

    // The quick-ask window's own submit. Not in the public bridge: it is a
    // message from a page this app shipped to the window that owns it.
    ipcMain.on('quick-ask:submit', (event, text: unknown) => {
        if (trustOf(event) !== 'shell') return;
        desktop.sendCommand({ kind: 'quick-ask', text: String(text ?? '') });
        desktop.showMain();
        BrowserWindow.fromWebContents(event.sender)?.hide();
    });
}

/** An ArrayBuffer arrives over IPC as itself; a typed array as a view of one. */
function toBuffer(data: ArrayBuffer | Uint8Array | undefined): Buffer {
    if (!data) return Buffer.alloc(0);
    return data instanceof ArrayBuffer ? Buffer.from(new Uint8Array(data)) : Buffer.from(data);
}

function sameHost(a: string, b: string): boolean {
    try {
        return new URL(a).host === new URL(b.includes('://') ? b : `https://${b}`).host;
    } catch {
        return false;
    }
}

function hostOf(url: string): string {
    try {
        return new URL(url.includes('://') ? url : `https://${url}`).host;
    } catch {
        return url;
    }
}
