import { FORM_CSS_POLICY, sanitizeCssClientWith } from '@/components/forms/formCssSanitizer';
import type { CssAddressPolicy, SanitizedCss } from '@/components/forms/formCssSanitizer';
import { assetUrl, isAssetRef } from './assets/assetUrl';
import type { AssetTransport } from './assets/assetUrl';

/**
 * The app's own stylesheet (`design.customCss`) on the web: the client half of
 * server/appStudio/appCss.mts. Keep the two in step; server/appStudio/appCss.vectors.json
 * is run by both.
 *
 * The server stores the text sanitised. The page sanitises it AGAIN before it mounts it, so
 * bytes that never passed this server's canonicalizer (an import, an older install, the
 * editor's unsaved draft) get the same rules:
 *
 *   • the form rules (formCssSanitizer.ts): no at-rule but @media, @supports and @container,
 *     no `position: fixed`, no `</`, balanced braces;
 *   • url() names only an image as data (`data:image/…`) or a file of the app (`asset:<id>`).
 *     Never a path: inside the signed-in product that is a request made as the viewer;
 *   • image-set(), image(), cross-fade() and src() take no address from var(), attr() or
 *     env(), and no string but `data:image/…`.
 *
 * wrapAppCss puts the result in `@scope ([data-app-css-root]) { … }`: the element a rule
 * matches then sits inside the app's root whatever the selector says. A browser without
 * @scope applies none of it.
 */

export const APP_CSS_MAX = 20_000;
export const APP_CSS_ROOT_ATTR = 'data-app-css-root';
export const APP_CSS_DARK_ATTR = 'data-app-dark';

const IMAGE_FUNCTIONS = ['image-set(', 'image(', 'cross-fade(', 'src('];
const ADDRESS_SOURCES = ['var(', 'attr(', 'env('];

const isInlineImage = (address: string): boolean => address.trim().toLowerCase().startsWith('data:image/');

/** The content of every string literal in `text` (a raw newline ends one, as in the browser). */
function stringsOf(text: string): string[] {
    const out: string[] = [];
    let quote = '';
    let current = '';
    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (!quote) {
            if (c === '\\') i += 1;
            else if (c === '"' || c === "'") { quote = c; current = ''; }
            continue;
        }
        if (c === '\\' && i + 1 < text.length) { current += text[i + 1]; i += 1; continue; }
        if (c === quote || c === '\n' || c === '\r' || c === '\f') { out.push(current); quote = ''; continue; }
        current += c;
    }
    if (quote) out.push(current);
    return out;
}

/** A declaration that builds an image from an address url() did not check. */
function imageFunctionProblem(decoded: string): string | null {
    const lower = decoded.toLowerCase();
    if (!IMAGE_FUNCTIONS.some((fn) => lower.includes(fn))) return null;
    if (ADDRESS_SOURCES.some((fn) => lower.includes(fn))) return 'address from var()';
    return stringsOf(decoded).every(isInlineImage) ? null : 'outside address';
}

const APP_CSS_POLICY: CssAddressPolicy = Object.freeze({
    allowUrl: (argument: string): boolean => isInlineImage(argument) || isAssetRef(argument.trim()),
    refuseString: FORM_CSS_POLICY.refuseString,
    refuseSegment: imageFunctionProblem,
});

/** The stylesheet as the page may mount it: `{ css, removed }`, never throws. */
export function sanitizeAppCssClient(input: unknown): SanitizedCss {
    if (typeof input !== 'string' || !input.trim()) return { css: '', removed: [] };
    if (input.length > APP_CSS_MAX) return { css: '', removed: [`over ${APP_CSS_MAX} characters`] };
    return sanitizeCssClientWith(input, APP_CSS_POLICY);
}

/** The sanitised text inside its scope. Empty text gives an empty string. */
export function wrapAppCss(css: string): string {
    return css.trim() ? `@scope ([${APP_CSS_ROOT_ATTR}]) {\n${css}\n}` : '';
}

const IDENT_CHARS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-\\';
const ASSET_ID_CHARS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-';
/** What the address of an asset is made of. One with anything else is not written into the text. */
const PLAIN_ADDRESS_CHARS = `${ASSET_ID_CHARS}./:%~@`;
const SPACE = ' \t\n\r\f';

/** Does `before` end in the function name `url` (and not in a longer identifier)? */
function endsInUrl(before: string): boolean {
    if (before.length < 3 || before.slice(-3).toLowerCase() !== 'url') return false;
    return before.length === 3 || !IDENT_CHARS.includes(before[before.length - 4]);
}

/**
 * The asset reference that is the WHOLE argument of the url( whose argument starts at
 * `from`, and where its `)` ends (exclusive); null for any other argument.
 */
function assetArgument(css: string, from: number): { ref: string; end: number } | null {
    let i = from;
    while (i < css.length && SPACE.includes(css[i])) i += 1;
    const quote = css[i] === '"' || css[i] === "'" ? css[i] : '';
    if (quote) i += 1;
    const start = i;
    if (!css.startsWith('asset:', i)) return null;
    i += 'asset:'.length;
    while (i < css.length && ASSET_ID_CHARS.includes(css[i])) i += 1;
    const ref = css.slice(start, i);
    if (quote) {
        if (css[i] !== quote) return null;
        i += 1;
    }
    while (i < css.length && SPACE.includes(css[i])) i += 1;
    return css[i] === ')' && isAssetRef(ref) ? { ref, end: i + 1 } : null;
}

const isPlainAddress = (url: string): boolean => [...url].every((ch) => PLAIN_ADDRESS_CHARS.includes(ch));

/**
 * `url(asset:<id>)` → `url(<the asset's address on this page>)`, in sanitised text. Only a
 * url() whose whole argument is an asset reference is touched, outside strings; the address
 * is written unquoted and holds nothing but address characters, so it cannot end a token.
 * Without an address for this page (no app id and no page token) the text stays as it is,
 * and the browser loads nothing for `asset:`.
 */
export function resolveCssAssets(css: string, transport: AssetTransport): string {
    if (!css.includes('asset:')) return css;
    let out = '';
    let quote = '';
    let i = 0;
    while (i < css.length) {
        const c = css[i];
        if (c === '\\') { out += css.slice(i, i + 2); i += 2; continue; }
        if (quote) {
            if (c === quote || c === '\n' || c === '\r' || c === '\f') quote = '';
        } else if (c === '"' || c === "'") {
            quote = c;
        } else if (c === '(' && endsInUrl(out)) {
            const hit = assetArgument(css, i + 1);
            const url = hit ? assetUrl(hit.ref, transport) : null;
            if (hit && url && isPlainAddress(url)) { out += `(${url})`; i = hit.end; continue; }
        }
        out += c;
        i += 1;
    }
    return out;
}

const CLASS_FIRST = 'abcdefghijklmnopqrstuvwxyz';
const CLASS_REST = `${CLASS_FIRST}0123456789-`;
export const CSS_CLASS_MAX = 40;

/** A class name an author may put on a node (`node.cssClass`); the server's isCssClassName. */
export function isCssClassName(value: unknown): value is string {
    if (typeof value !== 'string' || value.length < 1 || value.length > CSS_CLASS_MAX) return false;
    if (!CLASS_FIRST.includes(value[0])) return false;
    return [...value].every((ch) => CLASS_REST.includes(ch));
}

/** The cell's class list with the author's class (`u-<name>`) added; unchanged without a valid one. */
export function withAuthorClass(className: string | undefined, node: object): string | undefined {
    const name = (node as { cssClass?: unknown }).cssClass;
    if (!isCssClassName(name)) return className;
    return className ? `${className} u-${name}` : `u-${name}`;
}
