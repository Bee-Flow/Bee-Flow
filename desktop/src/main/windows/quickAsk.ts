/**
 * The quick-ask window.
 *
 * One global shortcut, one text field, straight into a conversation. It exists
 * because the fastest thing a desktop client can offer is not a faster app —
 * it is not having to find the app at all. The window is deliberately small,
 * frameless and always-on-top, and it closes on Escape or on losing focus, so
 * it never becomes another window to manage.
 */

import { BrowserWindow, screen } from 'electron';

import { hardenedWebPreferences } from './mainWindow.ts';
import { shellPageUrl } from './shellPages.ts';

const WIDTH = 680;
const HEIGHT = 168;

export interface QuickAskOptions {
    onSubmit: (text: string) => void;
}

export class QuickAskWindow {
    private window: BrowserWindow | null = null;
    private readonly options: QuickAskOptions;

    constructor(options: QuickAskOptions) {
        this.options = options;
    }

    /** Show it, creating it the first time. Focuses the field either way. */
    toggle(prefill = ''): void {
        if (this.window && !this.window.isDestroyed()) {
            if (this.window.isVisible()) {
                this.window.hide();
                return;
            }
            this.position();
            this.window.showInactive();
            this.window.focus();
            if (prefill) this.window.webContents.send('quick-ask:prefill', prefill);
            return;
        }
        this.create(prefill);
    }

    hide(): void {
        if (this.window && !this.window.isDestroyed()) this.window.hide();
    }

    destroy(): void {
        if (this.window && !this.window.isDestroyed()) this.window.destroy();
        this.window = null;
    }

    /** Called by the IPC handler when the window's field is submitted. */
    submit(text: string): void {
        this.hide();
        if (text.trim()) this.options.onSubmit(text.trim());
    }

    private create(prefill: string): void {
        const bounds = this.centredBounds();
        this.window = new BrowserWindow({
            ...bounds,
            frame: false,
            resizable: false,
            movable: true,
            minimizable: false,
            maximizable: false,
            fullscreenable: false,
            skipTaskbar: true,
            alwaysOnTop: true,
            show: false,
            transparent: false,
            backgroundColor: '#0f0f13',
            title: 'Ask Bee Flow',
            webPreferences: hardenedWebPreferences(),
        });

        void this.window.loadURL(shellPageUrl('quick-ask', prefill ? { text: prefill } : {}));

        this.window.once('ready-to-show', () => {
            this.window?.show();
            this.window?.focus();
        });
        // Losing focus is how this window is dismissed; there is nothing in it
        // worth keeping open behind whatever the user clicked instead.
        this.window.on('blur', () => this.hide());
        this.window.on('closed', () => {
            this.window = null;
        });
    }

    private position(): void {
        this.window?.setBounds(this.centredBounds());
    }

    /** Centred horizontally, a third of the way down — where the eye already is. */
    private centredBounds(): { x: number; y: number; width: number; height: number } {
        const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
        const area = display.workArea;
        return {
            width: Math.min(WIDTH, area.width - 40),
            height: HEIGHT,
            x: Math.round(area.x + (area.width - Math.min(WIDTH, area.width - 40)) / 2),
            y: Math.round(area.y + area.height / 4),
        };
    }
}
