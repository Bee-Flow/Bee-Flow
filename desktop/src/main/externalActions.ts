/**
 * Opening things outside the app: an address in the system browser, a file in
 * the OS file manager. No electron import; `shell` and the dialog come in
 * through the host.
 */

import { revealDecision } from './security/reveal.ts';

export interface OpenExternallyHost {
    info(tag: string, message: string): void;
    warn(tag: string, message: string): void;
    openExternal(url: string): Promise<void>;
    /** Informational: nothing waits for it to close. */
    showMessage(message: { type: 'info'; title: string; message: string; detail: string }): void;
}

/**
 * Open an address in the system browser. A failure used to be logged and
 * nothing more, so the click did nothing. Now the address is shown so it can
 * be copied.
 */
export async function openExternally(url: string, host: OpenExternallyHost): Promise<boolean> {
    host.info('Navigation', `opening in the browser: ${url}`);
    try {
        await host.openExternal(url);
        return true;
    } catch (error) {
        host.warn('Navigation', `could not open ${url}: ${String(error)}`);
        host.showMessage({
            type: 'info',
            title: 'No web browser could be opened',
            message: 'Bee Flow could not open your web browser.',
            detail: `Open this address in a browser yourself:\n\n${url}`,
        });
        return false;
    }
}

export interface RevealHost {
    warn(tag: string, message: string): void;
    /** The app's own files (log, settings), revealable when asked for. */
    ownFiles: readonly string[];
    isInsideSyncFolder(resolved: string): boolean;
    downloads(): string;
    showItemInFolder(path: string): void;
}

/**
 * Show a file in the OS file manager — only somewhere the user already chose
 * to share with this app (see security/reveal.ts).
 */
export function revealPath(target: unknown, options: { ownFiles?: boolean }, host: RevealHost): boolean {
    const decision = revealDecision(
        target,
        { ownFiles: host.ownFiles, isInsideSyncFolder: (resolved) => host.isInsideSyncFolder(resolved), downloads: host.downloads() },
        options,
    );
    if (!decision.ok) {
        host.warn('IPC', `refused to reveal ${decision.refused}`);
        return false;
    }
    host.showItemInFolder(decision.path);
    return true;
}
