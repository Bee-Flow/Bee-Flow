import { createContext, useContext } from 'react';

/**
 * Where overlays (dialogs, drag overlays, toasts) mount, and which document
 * their outside-click and Escape listeners belong to.
 *
 * Nothing provides it in the product, so every reader falls back to
 * `document.body` and `document`, exactly as before. The App Studio device
 * preview renders an app inside a same-origin iframe and provides the frame's
 * body here, so a dialog the app opens lands INSIDE the frame (and its media
 * queries) instead of over the editor.
 */
export const PortalRoot = createContext<HTMLElement | null>(null);

/** The element overlays portal into: the provided root, else `document.body`. */
export function usePortalRoot(): HTMLElement | null {
    const root = useContext(PortalRoot);
    if (root) return root;
    return typeof document === 'undefined' ? null : document.body;
}

/** The document overlays live in: the provided root's document, else `document`. */
export function usePortalDocument(): Document {
    const root = useContext(PortalRoot);
    return root?.ownerDocument ?? document;
}
