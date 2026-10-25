/**
 * What the app does with a `beeflow://` link once parseDeepLink has read it:
 * ask first when the action needs it, then route it. No electron import; the
 * dialog, the windows and the other flows come in through the host.
 */

import { EVENT } from '../shared/ipc.ts';
import { confirmationPrompt, parseDeepLink } from './deepLink.ts';

export interface DeepLinkHost {
    info(tag: string, message: string): void;
    /** A blocking yes/no question; true means "Continue". */
    confirm(prompt: { title: string; detail: string }): boolean;
    showMain(): void;
    serverUrl(): string;
    /** Load an address into the main window. */
    loadMain(url: string): void;
    quickAsk(text: string): void;
    setServer(url: string): Promise<unknown>;
    pairNextcloud(server: string): Promise<unknown>;
    revealPath(path: string): void;
    broadcast(channel: string, payload: unknown): void;
}

export function routeDeepLink(raw: string, host: DeepLinkHost): void {
    const action = parseDeepLink(raw);
    host.info('DeepLink', `${raw} → ${action.kind}`);

    if (action.kind === 'unknown') return;

    if (action.needsConfirmation) {
        const prompt = confirmationPrompt(action);
        const proceed = host.confirm({ title: prompt?.title ?? 'Continue?', detail: prompt?.detail ?? '' });
        if (!proceed) return;
    }

    switch (action.kind) {
        case 'navigate': {
            host.showMain();
            const base = host.serverUrl();
            if (base) host.loadMain(new URL(action.path, base).toString());
            break;
        }
        case 'quick-ask':
            host.quickAsk(action.text);
            break;
        case 'set-server':
            void host.setServer(action.url);
            break;
        case 'pair-nextcloud':
            void host.pairNextcloud(action.server);
            break;
        case 'open-path':
            // Revealed in its folder, never opened: `openPath` would run an
            // .exe, a script or a .desktop file with its default handler,
            // and a link from any web page could name one.
            host.revealPath(action.path);
            break;
        default:
            break;
    }
    host.broadcast(EVENT.deepLink, raw);
}
