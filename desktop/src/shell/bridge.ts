/**
 * The shell pages' view of `window.beeflow`.
 *
 * The preload exposes the bridge on the window object; TypeScript needs to be
 * told it is there. Declaring it in one file rather than in each page keeps the
 * shape in one place, next to the small helpers every page ends up wanting.
 */

import type { BeeflowBridge } from '../shared/ipc.ts';

declare global {
    interface Window {
        beeflow?: BeeflowBridge;
        beeflowQuickAsk?: {
            submit(text: string): void;
            onPrefill(listener: (text: string) => void): () => void;
        };
    }
}

/**
 * The bridge, or a loud failure.
 *
 * A shell page without the preload is not a degraded page, it is a broken one —
 * there is nothing on it that does not go through IPC. Better to say so than
 * to render a settings window where every control silently does nothing.
 */
export function bridge(): BeeflowBridge {
    const api = window.beeflow;
    if (!api) throw new Error('This page must run inside the Bee Flow desktop app.');
    return api;
}

export function byId<T extends HTMLElement>(id: string): T {
    const element = document.getElementById(id);
    if (!element) throw new Error(`Missing element #${id}`);
    return element as T;
}

/** Read a query parameter the main process put on the page URL. */
export function queryParam(name: string): string {
    return new URLSearchParams(window.location.search).get(name) ?? '';
}

export type StatusTone = '' | 'ok' | 'warn' | 'error';

export function setStatus(element: HTMLElement, message: string, tone: StatusTone = ''): void {
    element.textContent = message;
    element.className = tone ? `status ${tone}` : 'status';
}

/** `https://cloud.example.com/x` → `cloud.example.com`. */
export function hostOf(url: string): string {
    try {
        return new URL(url).host;
    } catch {
        return url;
    }
}
