import { useLayoutEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { APP_CSS_DARK_ATTR, APP_CSS_ROOT_ATTR, resolveCssAssets, sanitizeAppCssClient, wrapAppCss } from './appCss';
import { useAppCssOff } from './appCssSwitch';
import { useAssetTransport } from './assets/assetTransport';
import { useEditorChrome } from '../editor/EditorChromeContext';

/**
 * The place where an app's own stylesheet (`design.customCss`) is mounted.
 *
 * Every host that draws an app renders this once, as a child of the element that holds the
 * app: AppShell's <main> (the run view and the editor preview), the public page, the
 * headless screen and the editor canvas. That parent is the stylesheet's ROOT: while a
 * stylesheet is applied it carries `data-app-css-root` (what the @scope of appCss.ts names)
 * and `data-app-dark="true|false"` (the appearance the app resolved to, for the author's
 * dark rules).
 *
 * An app without a stylesheet renders nothing here and gets no attribute. The stylesheet is
 * not applied under the high-contrast host theme (accessibility beats app branding, as in
 * app-tokens.css), nor while the editor's "CSS off" switch is on for this app.
 *
 * `appId` / `publicToken` say where an `asset:<id>` in the text is fetched from (a public
 * page's token also arrives through AssetTransportProvider); without either such an image is
 * not loaded.
 */

interface Props {
    definition?: { [key: string]: unknown } | null;
    appId?: string | null;
    publicToken?: string | null;
}

const HIGH_CONTRAST = 'high-contrast';
const DARK_HOST_THEMES: readonly string[] = ['dark', 'obsidian', 'glass-dark'];

function subscribeHostTheme(onChange: () => void): () => void {
    if (typeof MutationObserver === 'undefined' || typeof document === 'undefined') return () => {};
    const observer = new MutationObserver(onChange);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => observer.disconnect();
}

const hostThemeNow = (): string => (typeof document === 'undefined' ? '' : document.documentElement.getAttribute('data-theme') || '');

/** The host theme (`<html data-theme>`), followed live. */
function useHostTheme(): string {
    return useSyncExternalStore(subscribeHostTheme, hostThemeNow, () => '');
}

const HEX = '0123456789abcdef';

/** `#rgb` / `#rrggbb` / `rgb(r, g, b)` / `rgba(r g b / a)` as [r, g, b]; null for anything else. */
function parseColour(raw: string): [number, number, number] | null {
    const text = raw.trim().toLowerCase();
    if (text.startsWith('#')) {
        const hex = text.slice(1);
        if (![...hex].every((ch) => HEX.includes(ch))) return null;
        if (hex.length === 3) return [0, 1, 2].map((i) => parseInt(hex[i] + hex[i], 16)) as [number, number, number];
        if (hex.length === 6 || hex.length === 8) return [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number];
        return null;
    }
    if (!text.startsWith('rgb') || !text.endsWith(')')) return null;
    const parts = text.slice(text.indexOf('(') + 1, -1).split(',').join(' ').split('/').join(' ').split(' ').filter(Boolean).map(Number);
    return parts.length >= 3 && parts.slice(0, 3).every((n) => Number.isFinite(n)) ? [parts[0], parts[1], parts[2]] : null;
}

/** Is the ground the app stands on dark? Its own appearance decides; `auto` follows the host. */
function resolvesDark(appearance: unknown, hostTheme: string, root: Element): boolean {
    if (appearance === 'dark') return true;
    if (appearance === 'light') return false;
    const ground = parseColour(getComputedStyle(root).getPropertyValue('--bg-primary') || '');
    if (!ground) return DARK_HOST_THEMES.includes(hostTheme);
    return (0.2126 * ground[0] + 0.7152 * ground[1] + 0.0722 * ground[2]) / 255 < 0.5;
}

export default function AppCustomCss({ definition, appId, publicToken }: Props) {
    const design = definition?.design as { customCss?: unknown } | null | undefined;
    const raw = design?.customCss;
    const appearance = (definition?.theme as { appearance?: unknown } | null | undefined)?.appearance;
    const hostTheme = useHostTheme();
    const chrome = useEditorChrome();
    const off = useAppCssOff(chrome?.appId) && !!chrome;
    // The page token of a public page wins, whether it came as a prop or from the provider around the shell.
    const transport = useAssetTransport(appId ?? chrome?.appId);
    const address = transport.appId ?? null;
    const token = publicToken ?? transport.publicToken ?? null;
    const text = useMemo(() => {
        if (typeof raw !== 'string' || !raw) return '';
        return wrapAppCss(resolveCssAssets(sanitizeAppCssClient(raw).css, { appId: address, publicToken: token }));
    }, [raw, address, token]);
    const applied = !!text && !off && hostTheme !== HIGH_CONTRAST;
    const ref = useRef<HTMLStyleElement>(null);

    useLayoutEffect(() => {
        const root = applied ? ref.current?.parentElement : null;
        if (!root) return undefined;
        root.setAttribute(APP_CSS_ROOT_ATTR, '');
        root.setAttribute(APP_CSS_DARK_ATTR, String(resolvesDark(appearance, hostTheme, root)));
        return () => {
            root.removeAttribute(APP_CSS_ROOT_ATTR);
            root.removeAttribute(APP_CSS_DARK_ATTR);
        };
    }, [applied, appearance, hostTheme]);

    if (!applied) return null;
    return <style ref={ref} data-app-custom-css="">{text}</style>;
}
