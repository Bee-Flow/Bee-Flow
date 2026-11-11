// @typecheck strict
/**
 * Custom block: the document of the frame a block is drawn in.
 *
 * The frame is `<iframe sandbox="allow-same-origin" srcdoc=…>`:
 *   - WITHOUT allow-scripts, so no script, event-handler attribute or javascript: address in
 *     it can run, whatever the document holds;
 *   - without allow-forms, allow-popups and allow-top-navigation;
 *   - with allow-same-origin only so that the host page can measure the content and hear a
 *     click on a wired control. Nothing in the frame can use that origin: it runs no code.
 *
 * The document carries its own policy (FRAME_CSP): nothing may be loaded but a background
 * image given as inline data in the stylesheet, and a style written in the document. The host writes the whole document:
 * head and policy here, the body from serializeFrameBody. The policy is the second line; the
 * first is that the body cannot hold anything that asks for an address (vocabulary.mjs).
 */

import { escapeAttr } from './serialize.mjs';

/** The sandbox tokens of the frame. Never add allow-scripts. */
export const FRAME_SANDBOX = 'allow-same-origin';
export const FRAME_CSP = "default-src 'none'; img-src data:; style-src 'unsafe-inline'; form-action 'none'; base-uri 'none'";

export const FRAME_MIN_HEIGHT = 24;
export const FRAME_MAX_HEIGHT = 4000;

/** A height the content asks for, as whole pixels inside the allowed band. */
export function clampFrameHeight(/** @type {number} */ height) {
    if (!Number.isFinite(height)) return FRAME_MIN_HEIGHT;
    return Math.min(FRAME_MAX_HEIGHT, Math.max(FRAME_MIN_HEIGHT, Math.ceil(height)));
}

const THEME_CHARS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 #(),.%_-';
const THEME_KEY_CHARS = 'abcdefghijklmnopqrstuvwxyz-';
const LANG_CHARS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-';

/** @param {string} text @param {string} chars */
function only(text, chars) {
    let out = '';
    for (const ch of text) if (chars.includes(ch)) out += ch;
    return out;
}

/**
 * The look of the app as CSS variables (`--bf-<key>`). A value keeps only the characters a
 * colour, a length or a font list needs, so it can say nothing else.
 * @param {Record<string, unknown>} theme
 */
export function themeVariables(theme) {
    let out = '';
    for (const [key, raw] of Object.entries(theme || {})) {
        const name = only(String(key), THEME_KEY_CHARS);
        const value = only(String(raw ?? ''), THEME_CHARS).slice(0, 200);
        if (name && name === key && value && !value.toLowerCase().includes('url')) out += `--bf-${name}:${value};`;
    }
    return out;
}

const BASE_CSS = 'html,body{margin:0;padding:0;background:transparent}'
    + 'body{display:flow-root;color:var(--bf-text,#111827);font-family:var(--bf-font,system-ui,sans-serif);font-size:14px;line-height:1.5;overflow-wrap:anywhere}'
    + '[hidden]{display:none!important}';

/** Stylesheet text that cannot end its <style> element. */
function styleText(/** @type {string} */ css) {
    return css.includes('</') || css.includes('<!--') ? '' : css;
}

/**
 * @param {{ body: string, css?: string, theme?: Record<string, unknown>, lang?: string, dark?: boolean }} parts
 *   `body` comes from serializeFrameBody, `css` from the stylesheet sanitiser.
 */
export function buildFrameDocument(parts) {
    const lang = only(String(parts.lang || 'en'), LANG_CHARS).slice(0, 35) || 'en';
    const scheme = parts.dark ? 'dark' : 'light';
    return '<!doctype html>'
        + `<html lang="${escapeAttr(lang)}" data-appearance="${scheme}"><head><meta charset="utf-8">`
        + `<meta http-equiv="Content-Security-Policy" content="${escapeAttr(FRAME_CSP)}">`
        + '<meta name="referrer" content="no-referrer">'
        + `<style>:root{color-scheme:${scheme};${themeVariables(parts.theme || {})}}${BASE_CSS}</style>`
        + `<style>${styleText(String(parts.css || ''))}</style>`
        + `</head><body>${parts.body}</body></html>`;
}
