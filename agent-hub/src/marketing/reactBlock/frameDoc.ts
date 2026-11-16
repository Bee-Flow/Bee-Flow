/**
 * The document of a `react-component` block's sandboxed frame (its srcdoc):
 * the site's theme as `--bf-*` variables, the author's stylesheet, the
 * self-hosted React runtime and the call that mounts the compiled component.
 *
 * Everything is inline. The frame has no origin of its own (sandbox without
 * allow-same-origin) and the page's CSP allows inline scripts, so nothing is
 * fetched to start it, from this site or anywhere else.
 */
import { REACT_THEME_VARS } from '@shared/cmsReact/compile.mjs';
import { defangScriptClose } from '@shared/webpage/previewInline.mjs';
import { installRelay } from './sealedRelay';

export type FrameMode = 'public' | 'editor';

const BODY_FONT = "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";

/** Where each `--bf-*` variable comes from: the marketing token, and the value when that token is not there. */
const TOKEN_OF: Record<string, readonly [string, string]> = {
    '--bf-primary': ['--brand-primary', '#F5A623'],
    '--bf-secondary': ['--brand-secondary', '#1F2937'],
    '--bf-accent': ['--brand-accent', '#FFD166'],
    '--bf-background': ['--brand-bg', '#FFFFFF'],
    '--bf-surface': ['--brand-surface', '#F7F8FA'],
    '--bf-text': ['--brand-text', '#0F172A'],
    '--bf-text-secondary': ['--brand-text-secondary', '#475569'],
    '--bf-font-body': ['--font-body', BODY_FONT],
    '--bf-font-heading': ['--font-heading', BODY_FONT],
    '--bf-radius': ['--radius-base', '12px'],
};

/**
 * `--bf-*` name, its marketing token and fallback, for exactly the variables
 * the compiler documents (REACT_THEME_VARS, shared/cmsReact/compile.mjs).
 */
export const THEME_VARS: ReadonlyArray<readonly [string, string, string]> = REACT_THEME_VARS
    .filter((name) => TOKEN_OF[name])
    .map((name) => [name, TOKEN_OF[name][0], TOKEN_OF[name][1]] as const);

/** `--bf-*` name -> value. */
export type SiteTheme = Record<string, string>;

/** A value that cannot leave its declaration: no `;`, braces or angle brackets. */
function cleanValue(v: string): string {
    return v.replace(/[;{}<>]/g, '').trim();
}

/**
 * The site's theme as it applies at `el`: a band (dark, primary, ...) re-themes
 * the --brand-* tokens of its block, so they are read where the block sits.
 */
export function readSiteTheme(el: Element | null): SiteTheme {
    let style: CSSStyleDeclaration | null = null;
    if (el && typeof window !== 'undefined' && typeof window.getComputedStyle === 'function') {
        style = window.getComputedStyle(el);
    }
    const out: SiteTheme = {};
    for (const [name, token, fallback] of THEME_VARS) {
        const v = style ? cleanValue(style.getPropertyValue(token)) : '';
        out[name] = v || fallback;
    }
    return out;
}

/** The theme as one `:root { … }` rule; also the key that says when the frame must be rebuilt. */
export function themeCss(theme: SiteTheme): string {
    const lines = THEME_VARS.map(([name, , fallback]) => `${name}:${cleanValue(theme[name] || '') || fallback};`);
    return `:root{${lines.join('')}}`;
}

/** JSON that can sit inside a <script>: `<` never appears literally, so neither does `</script>` or `<!--`. */
export function scriptJson(value: unknown): string {
    return JSON.stringify(value ?? null)
        .replace(/</g, '\\u003c');
}

/** Author CSS that cannot close its <style> element. */
function defangStyleClose(css: string): string {
    return String(css || '').replace(/<\/style/gi, '<\\/style');
}

const BASE_CSS = [
    'html,body{margin:0;padding:0;background:transparent}',
    // flow-root: a child's top margin stays inside the body, so the height reported is the height drawn.
    'body{display:flow-root;font-family:var(--bf-font-body);color:var(--bf-text);-webkit-font-smoothing:antialiased}',
    '.bf-react-error{margin:0;padding:12px 14px;border:1px solid #fecaca;border-radius:8px;background:#fef2f2;color:#991b1b;font:13px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace}',
    '.bf-react-error strong{display:block;white-space:pre-wrap;word-break:break-word}',
    '.bf-react-error pre{margin:8px 0 0;white-space:pre-wrap;word-break:break-word;font:inherit;opacity:.8}',
].join('\n');

export interface FrameDocInput {
    /** The runtime IIFE (virtual:cms-react-runtime). */
    runtime: string;
    /** The CommonJS body compileReactBlock produced. */
    compiled: string;
    css?: string;
    /** The `:root{…}` rule of themeCss. */
    theme: string;
    props: Record<string, unknown>;
    mode: FrameMode;
    /** The page's language, for `<html lang>` (a screen reader picks its voice by it). */
    lang?: string;
    /** 'site' (the website, the default) or 'sealed' (App Studio react_block, see SEALED_FRAME_CSP). */
    policy?: FramePolicy;
}

/**
 * Who the frame is for. A website block shows public content and may link out. A sealed frame
 * (App Studio's react_block) is handed app data, so it must not be able to send it anywhere.
 */
export type FramePolicy = 'site' | 'sealed';

/**
 * The policy a sealed frame's document carries, as the FIRST element of its head (a policy in a
 * meta element covers only what comes after it). The inline React runtime and the compiled
 * component run, inline styles apply, images and fonts come only as data: URLs, and nothing else
 * is allowed: there is no connect-src, so fetch, XHR, WebSocket, EventSource and sendBeacon all
 * fall under default-src 'none'. No 'unsafe-eval': neither the runtime nor the compiler output
 * evaluates strings. A srcdoc document also inherits the embedding page's policy; both apply.
 */
export const SEALED_FRAME_CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; base-uri 'none'; form-action 'none'";

/**
 * The sandbox of a sealed frame: scripts only. No allow-same-origin (an opaque origin: no access
 * to the page, its cookies or storage), no popups, no top navigation, no forms, no modals.
 */
export const SEALED_FRAME_SANDBOX = 'allow-scripts';

/**
 * The policy of the OUTER frame of a sealed block (./sealedRelay.ts): its one inline script (the
 * relay) runs, and no frame may load into it from anywhere (frame-src 'none', child-src 'none';
 * a srcdoc document is not a load). The inner frame's navigations are held to this policy, so
 * the component cannot navigate its own frame away, whatever policy the app page has.
 */
export const SEALED_OUTER_CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; frame-src 'none'; child-src 'none'; base-uri 'none'; form-action 'none'";

/** Text for a double-quoted attribute. */
function attr(text: string): string {
    return text.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * The outer document of a sealed block: its policy, the relay, and the inner sandboxed frame that
 * holds `inner` (buildReactFrameDoc with policy 'sealed'), filling it. The app page sizes the
 * outer frame from the heights the relay passes on.
 */
export function buildSealedOuterDoc(inner: string, title = ''): string {
    return [
        `<!DOCTYPE html><html><head><meta http-equiv="Content-Security-Policy" content="${SEALED_OUTER_CSP}"><meta charset="utf-8">`,
        '<style>html,body{margin:0;padding:0;height:100%;overflow:hidden;background:transparent}iframe{display:block;border:0;width:100%;height:100%;background:transparent}</style>',
        `</head><body><iframe id="bf-inner" sandbox="${SEALED_FRAME_SANDBOX}" title="${attr(title)}" srcdoc="${attr(inner)}"></iframe>`,
        `<script>(${defangScriptClose(String(installRelay))})(window,document.getElementById('bf-inner'));</script>`,
        '</body></html>',
    ].join('');
}

/** The head of a sealed frame: the policy first, then nothing that names an address. */
function sealedHead(): string {
    return [
        `<meta http-equiv="Content-Security-Policy" content="${SEALED_FRAME_CSP}">`,
        '<meta charset="utf-8">',
        '<meta http-equiv="x-dns-prefetch-control" content="off">',
        '<meta name="referrer" content="no-referrer">',
        '<meta name="viewport" content="width=device-width, initial-scale=1">',
    ].join('');
}

/** A BCP 47-shaped tag (`en`, `nl`, `pt-BR`), else ''. Checked by character, never echoed raw. */
export function frameLang(lang: unknown): string {
    const s = typeof lang === 'string' ? lang.trim() : '';
    if (!s || s.length > 12) return '';
    for (const ch of s) {
        const ok = (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || (ch >= '0' && ch <= '9') || ch === '-';
        if (!ok) return '';
    }
    return s;
}

/**
 * The frame document. Links open in the top window on the public site; in the
 * editor preview they open in a new tab, so a click never navigates the
 * editor away from unsaved work.
 *
 * A sealed frame gets no <base> (it may not navigate anything) and no props in
 * the document: its data arrives by postMessage only (`bf-react-props`), and the
 * runtime renders once the first set is there (`sealed: true`).
 */
export function buildReactFrameDoc({ runtime, compiled, css = '', theme, props, mode, lang, policy = 'site' }: FrameDocInput): string {
    const sealed = policy === 'sealed';
    const target = mode === 'editor' ? '_blank' : '_top';
    const tag = frameLang(lang);
    const head = sealed
        ? sealedHead()
        : `<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><base target="${target}">`;
    const opts = sealed ? { mode, sealed: true } : { mode };
    return [
        `<!DOCTYPE html><html${tag ? ` lang="${tag}"` : ''}><head>${head}`,
        `<style>${defangStyleClose(theme)}\n${BASE_CSS}</style>`,
        css ? `<style>${defangStyleClose(css)}</style>` : '',
        '</head><body><div id="root"></div>',
        `<script>${defangScriptClose(runtime)}</script>`,
        `<script>__bfReactMount(function(module,exports,require){\n${defangScriptClose(compiled)}\n},${scriptJson(sealed ? null : props)},${scriptJson(opts)});</script>`,
        '</body></html>',
    ].join('');
}
