/**
 * The tray icon.
 *
 * On Windows and Linux this is what makes the app a background workspace
 * rather than a window: close it and Bee Flow keeps running, notifications keep
 * arriving, the quick-ask shortcut keeps working. On macOS the Dock already
 * plays that role, so the tray is there for the menu, not for survival.
 *
 * The menu deliberately shows the Nextcloud bridge's state. It is the one place
 * a user can see, at a glance, whether the two apps have found each other —
 * which is the first question when a share link or a sync badge is missing.
 */

import { Menu, Tray, app, nativeImage } from 'electron';
import * as path from 'node:path';

import type { NextcloudStatus } from '../shared/types.ts';
import { hostOf, nextcloudSummary } from './nextcloud/summary.ts';

export interface TrayActions {
    open: () => void;
    newChat: () => void;
    quickAsk: () => void;
    openSettings: () => void;
    refreshNextcloud: () => void;
    openNextcloudFolder: () => void;
    quit: () => void;
}

export interface TrayOptions {
    actions: TrayActions;
    nextcloud: () => NextcloudStatus;
    serverUrl: () => string;
}

/** Resolved from `resources/`, which electron-builder packs next to the app. */
function iconPath(name: string): string {
    return app.isPackaged
        ? path.join(process.resourcesPath, 'resources', name)
        : path.resolve(__dirname, '../../resources', name);
}

export class AppTray {
    private tray: Tray | null = null;
    private readonly options: TrayOptions;

    constructor(options: TrayOptions) {
        this.options = options;
    }

    create(): void {
        if (this.tray) return;

        // macOS wants a monochrome template image it can invert for dark menu
        // bars; Windows and Linux want the real icon. Both are resized here
        // rather than shipped at a dozen sizes.
        const isMac = process.platform === 'darwin';
        const image = nativeImage
            .createFromPath(iconPath(isMac ? 'trayTemplate.png' : 'tray.png'))
            .resize({ width: isMac ? 18 : 24, height: isMac ? 18 : 24 });
        if (isMac) image.setTemplateImage(true);

        this.tray = new Tray(image);
        this.tray.setToolTip('Bee Flow');
        this.tray.on('click', () => this.options.actions.open());
        this.tray.on('double-click', () => this.options.actions.open());
        this.refresh();
    }

    /** Rebuild the menu. Called whenever the state it shows changes. */
    refresh(): void {
        if (!this.tray) return;
        const nextcloud = this.options.nextcloud();
        const server = this.options.serverUrl();

        this.tray.setContextMenu(
            Menu.buildFromTemplate([
                { label: server ? `Bee Flow — ${hostOf(server)}` : 'Bee Flow — no server yet', enabled: false },
                { type: 'separator' },
                { label: 'Open Bee Flow', click: this.options.actions.open },
                { label: 'New chat', click: this.options.actions.newChat },
                { label: 'Quick ask…', click: this.options.actions.quickAsk },
                { type: 'separator' },
                {
                    label: 'Nextcloud',
                    submenu: [
                        { label: nextcloudSummary(nextcloud), enabled: false },
                        { type: 'separator' },
                        {
                            label: 'Open sync folder',
                            enabled: nextcloud.accounts.some((account) => account.folders.length > 0),
                            click: this.options.actions.openNextcloudFolder,
                        },
                        { label: 'Look for Nextcloud again', click: this.options.actions.refreshNextcloud },
                    ],
                },
                { type: 'separator' },
                { label: 'Settings…', click: this.options.actions.openSettings },
                { label: 'Quit Bee Flow', click: this.options.actions.quit },
            ]),
        );
    }

    destroy(): void {
        this.tray?.destroy();
        this.tray = null;
    }
}
