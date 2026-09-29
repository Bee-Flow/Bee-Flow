/**
 * The local pages this app serves itself, and how to address them.
 *
 * They exist so the client is useful before it can reach anything: a first-run
 * server picker, a settings window, and an honest error page for when the
 * server is unreachable. Loading them from `file://` rather than from a custom
 * protocol keeps the packaging simple and the navigation policy's `file://`
 * rule (security/policy.ts) narrow and checkable.
 */

import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

export type ShellPage = 'welcome' | 'settings' | 'unreachable' | 'quick-ask';

/** Where the compiled shell UI lives, relative to this file in `dist/`. */
export function shellDirectory(): string {
    // dist/main/windows/shellPages.js → dist/ui/shell
    return path.resolve(__dirname, '../../ui/shell');
}

export function shellPageUrl(page: ShellPage, query: Record<string, string> = {}): string {
    const url = pathToFileURL(path.join(shellDirectory(), `${page}.html`));
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
    return url.toString();
}

/** The compiled preload, alongside the main process output. */
export function preloadPath(): string {
    return path.resolve(__dirname, '../../preload/index.js');
}
