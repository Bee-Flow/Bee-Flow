/**
 * Native notifications.
 *
 * The SPA already knows how to raise a Web Notification, and in a browser that
 * is the right answer. In a desktop app it is not quite: a Web Notification
 * from a page cannot outlive the window being closed to the tray, cannot carry
 * a deep link the shell understands, and on Windows shows up attributed to
 * Chromium rather than to Bee Flow. So the bridge offers a native path, and the
 * SPA uses it when `window.beeflow` is there.
 */

import { Notification } from 'electron';

import type { DesktopSettings } from '../shared/types.ts';

export interface NotifyInput {
    title: string;
    body: string;
    silent?: boolean;
    /** Opened when the notification is clicked. */
    deepLink?: string;
}

export interface NotifierOptions {
    settings: () => DesktopSettings;
    /** True when the main window has focus — used by the "only when away" rule. */
    isFocused: () => boolean;
    onActivate: (deepLink: string | undefined) => void;
}

export class Notifier {
    private readonly options: NotifierOptions;

    constructor(options: NotifierOptions) {
        this.options = options;
    }

    /** Returns whether a notification was actually shown, for the caller's log. */
    show(input: NotifyInput): boolean {
        const settings = this.options.settings();
        if (!settings.notifications.enabled) return false;
        if (settings.notifications.onlyWhenUnfocused && this.options.isFocused()) return false;
        if (!Notification.isSupported()) return false;

        const notification = new Notification({
            title: String(input.title ?? 'Bee Flow').slice(0, 200),
            body: String(input.body ?? '').slice(0, 1000),
            silent: input.silent === true,
        });
        notification.on('click', () => this.options.onActivate(input.deepLink));
        notification.show();
        return true;
    }
}
