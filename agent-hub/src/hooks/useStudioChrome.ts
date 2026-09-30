// Whether the Studio menu (the rail that replaces the sidebar on /app/studio)
// is out of the way while an automation is open. Two things share one flag:
// the toggle in the builder header, and the fullscreen button on the canvas,
// which also asks the browser for real fullscreen. It is a module store, not
// state in AgentHub, because the builder that flips it and the sidebar that
// obeys it are far apart in the tree and neither owns the other.
//
// It is never remembered: leaving the builder always brings the menu back
// (`releaseStudioChrome`), so nobody lands in the Studio without a menu.

import { useSyncExternalStore } from 'react';

let hidden = false;
const listeners = new Set<() => void>();

const emit = () => listeners.forEach((l) => l());
const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };
const isFullscreen = () => typeof document !== 'undefined' && !!document.fullscreenElement;

/** True while the Studio menu is hidden. */
export function useStudioMenuHidden(): boolean {
    return useSyncExternalStore(subscribe, () => hidden, () => false);
}

export function setStudioMenuHidden(next: boolean): void {
    if (hidden === next) return;
    hidden = next;
    emit();
}

/** Bring the menu back and leave browser fullscreen; called when the builder closes. */
export function releaseStudioChrome(): void {
    setStudioMenuHidden(false);
    if (isFullscreen()) void document.exitFullscreen?.().catch(() => { /* already out */ });
}

/**
 * Canvas fullscreen: the Studio menu goes and the browser goes fullscreen.
 * A browser that refuses fullscreen still gets the hidden menu.
 */
export function toggleCanvasFullscreen(): void {
    if (hidden) { releaseStudioChrome(); return; }
    setStudioMenuHidden(true);
    if (!isFullscreen()) void document.documentElement.requestFullscreen?.().catch(() => { /* refused: the menu is hidden anyway */ });
}

/** Escape leaves browser fullscreen without going through our button: bring the menu back with it. */
if (typeof document !== 'undefined') {
    let wasFullscreen = false;
    document.addEventListener('fullscreenchange', () => {
        const now = isFullscreen();
        if (wasFullscreen && !now) setStudioMenuHidden(false);
        wasFullscreen = now;
    });
}
