import { useEffect } from 'react';
import type { AppDesign } from './appDesign';
// Self-hosted @font-face declarations (Satoshi, General Sans, Cabinet Grotesk, Inter)
// — a plain import so the bytes are served from Bee Flow itself. Idempotent:
// the bundler includes the stylesheet once however many modules import it.
import '@/marketing/self-hosted-fonts.css';

/**
 * The design fonts whose @font-face rules live in fonts/designFonts.css (files under
 * agent-hub/public/fonts). Loaded on demand: only an app that names one carries the rules.
 */
const DESIGN_FONT_FACES = new Set(['geist', 'plex', 'poppins']);

/** Load the @font-face rules `font` needs (system and the families of self-hosted-fonts.css need none). */
function loadDesignFontFaces(font: string): void {
    if (!DESIGN_FONT_FACES.has(font)) return;
    import('./fonts/designFonts.css').catch(() => {}); // a font is never worth breaking the app for
}

/**
 * Loads the typeface an app's design asks for.
 *
 * Every family is served by Bee Flow itself: no request ever leaves for another host (this is
 * a privacy product, and a font request is a request), on the run page, in the editor and on
 * public pages alike. `system` (the default) loads nothing at all.
 *
 * Renders nothing. The rules stay in place on unmount: fonts are global, cheap, and removing
 * one mid-session would restyle whatever else is using it.
 */
export default function AppFontLoader({ definition }: { definition?: { design?: AppDesign; [key: string]: unknown } | null }) {
    const font = definition?.design?.font || 'system';

    useEffect(() => {
        loadDesignFontFaces(font);
    }, [font]);

    return null;
}
