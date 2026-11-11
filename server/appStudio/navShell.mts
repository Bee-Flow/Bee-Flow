/**
 * App Studio: the shell options of an app (schema 3), the keys of `definition.nav` beside
 * `style` and `groups`:
 *
 *   nav.style      'none' (appended to NAV_STYLES): no navigation chrome at all, for a
 *                  single-screen or embedded app. The viewer keeps a small corner menu.
 *   nav.header     'bar' | 'hidden': 'hidden' draws no top bar (the phone bar of a sidebar);
 *                  a small corner with the screen menu and the user menu takes its place.
 *   nav.items      [{ id, label, icon, screenId | url }] at most 10: links of the app's own
 *                  beside its screens. A screen target is resolved like a nav group's screen;
 *                  a url is http or https only and opens as a plain link.
 *   nav.footerText plain text under every screen, at most 120 characters.
 *   nav.brand      { name?, logo?, showName? }: the name and logo the shell shows instead of
 *                  meta.name and design.logoUrl (a logo is https or asset:<id>).
 *
 * Every key is emit-when-present: a nav without them keeps its bytes. `nav` never travels to a
 * public page (publicAccess.js buildPublicDefinition), so neither do these. The marks that
 * version them and describe them to the builder are componentSpecs/keys/nav/<key>.js.
 *
 * Pass 1 (canonNavShell) keeps the shape; pass 2 (resolveNavShell) resolves item screen ids
 * once the screens have their final ids, the way resolveNavScreens does for groups.
 */

import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { sameJsonValue } from '../shared/format/sameJsonValue.mjs';

const nodeRequire = createRequire(import.meta.url);
const { isAssetRef } = nodeRequire('./componentSpecs/valueTypes.js') as { isAssetRef: (v: unknown) => v is string };

type Push = (code: string, path: string, message: string) => void;
type Finding = { code: string; severity: string; path: string; message: string; hint: string };
type PushFinding = (finding: Finding) => void;
type Bag = Record<string, unknown>;

export interface NavItem { id: string; label: string; icon: string | null; screenId?: string; url?: string }
export interface NavBrand { name?: string; logo?: string; showName?: boolean }

export const NAV_SHELL_LIMITS = Object.freeze({
    MAX_ITEMS: 10,
    MAX_ITEM_LABEL: 40,
    MAX_URL: 500,
    MAX_FOOTER: 120,
    MAX_BRAND_NAME: 60,
    MAX_ICON: 64,
});

export const NAV_HEADERS: readonly string[] = Object.freeze(['bar', 'hidden']);
/** The shell keys of nav, in the order the stored object writes them (after style and groups). */
export const NAV_SHELL_KEYS: readonly string[] = Object.freeze(['header', 'items', 'footerText', 'brand']);

const ITEM_ID_PREFIX = 'nvi_';
const ID_CHARS = 'abcdefghijklmnopqrstuvwxyz0123456789';

const isObject = (v: unknown): v is Bag => v !== null && typeof v === 'object' && !Array.isArray(v);

/** `nvi_` and 4..12 lower-case letters or digits, checked character by character. */
export function isNavItemId(value: unknown): value is string {
    if (typeof value !== 'string' || !value.startsWith(ITEM_ID_PREFIX)) return false;
    const rest = value.slice(ITEM_ID_PREFIX.length);
    return rest.length >= 4 && rest.length <= 12 && [...rest].every((ch) => ID_CHARS.includes(ch));
}

function hasControlOrSpace(text: string): boolean {
    for (const ch of text) {
        const code = ch.codePointAt(0) ?? 0;
        if (code <= 0x20 || code === 0x7f) return true;
    }
    return false;
}

/** The stored form of a link address: an absolute http or https URL, or null. */
export function cleanNavUrl(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const text = value.trim();
    if (!text || text.length > NAV_SHELL_LIMITS.MAX_URL || hasControlOrSpace(text)) return null;
    const lower = text.toLowerCase();
    if (!lower.startsWith('https://') && !lower.startsWith('http://')) return null;
    let parsed: URL;
    try { parsed = new URL(text); } catch { return null; }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
    if (!parsed.hostname || parsed.username || parsed.password) return null;
    return parsed.href.length <= NAV_SHELL_LIMITS.MAX_URL ? parsed.href : null;
}

function cleanText(value: unknown, max: number): string | null {
    if (typeof value !== 'string') return null;
    const text = value.split('\n').join(' ').trim();
    return text ? text.slice(0, max) : null;
}

function mintItemId(seen: Set<string>): string {
    let id: string;
    do { id = ITEM_ID_PREFIX + randomBytes(3).toString('hex'); } while (seen.has(id));
    return id;
}

function cleanItem(raw: unknown, i: number, seen: Set<string>, push: Push): NavItem | null {
    const path = `nav.items[${i}]`;
    if (!isObject(raw)) { push('nav.item_invalid', path, 'A nav item is an object { label, icon?, screenId | url } — dropped.'); return null; }
    const label = cleanText(raw.label, NAV_SHELL_LIMITS.MAX_ITEM_LABEL);
    if (!label) { push('nav.item_invalid', path, 'A nav item needs a label — dropped.'); return null; }
    const screenId = typeof raw.screenId === 'string' && raw.screenId.trim() ? raw.screenId.trim() : null;
    const url = screenId ? null : cleanNavUrl(raw.url);
    if (!screenId && !url) {
        push('nav.item_target', path, `Nav item "${label}" needs a screenId of this app or an http(s) url of at most ${NAV_SHELL_LIMITS.MAX_URL} characters — dropped.`);
        return null;
    }
    if (screenId && raw.url !== undefined) push('nav.item_target', path, `Nav item "${label}" has both a screenId and a url; the screen was kept.`);
    let id = isNavItemId(raw.id) && !seen.has(raw.id) ? raw.id : null;
    if (!id) {
        id = mintItemId(seen);
        if (raw.id !== undefined) push('nav.item_id', `${path}.id`, `Nav item id reassigned to "${id}" (must match nvi_<4-12 lower-case letters or digits> and be unique).`);
    }
    seen.add(id);
    const icon = typeof raw.icon === 'string' && raw.icon.trim() ? raw.icon.trim().slice(0, NAV_SHELL_LIMITS.MAX_ICON) : null;
    return screenId ? { id, label, icon, screenId } : { id, label, icon, url: url as string };
}

function cleanItems(raw: unknown, push: Push): NavItem[] | null {
    if (!Array.isArray(raw)) { push('nav.items_invalid', 'nav.items', 'nav.items must be an array of { label, icon?, screenId | url } — dropped.'); return null; }
    const seen = new Set<string>();
    const items: NavItem[] = [];
    raw.forEach((entry, i) => {
        if (items.length >= NAV_SHELL_LIMITS.MAX_ITEMS) {
            if (i === NAV_SHELL_LIMITS.MAX_ITEMS) push('nav.too_many_items', `nav.items[${i}]`, `At most ${NAV_SHELL_LIMITS.MAX_ITEMS} nav items — the rest were dropped.`);
            return;
        }
        const item = cleanItem(entry, i, seen, push);
        if (item) items.push(item);
    });
    return items.length ? items : null;
}

function cleanBrandLogo(value: unknown): string | null {
    if (isAssetRef(value)) return value;
    return typeof value === 'string' && value.startsWith('https://') && value.length <= NAV_SHELL_LIMITS.MAX_URL && !hasControlOrSpace(value) ? value : null;
}

function cleanBrand(raw: unknown, push: Push): NavBrand | null {
    if (!isObject(raw)) { push('nav.brand_invalid', 'nav.brand', 'nav.brand must be an object { name?, logo?, showName? } — dropped.'); return null; }
    const out: NavBrand = {};
    const name = cleanText(raw.name, NAV_SHELL_LIMITS.MAX_BRAND_NAME);
    if (name) out.name = name;
    if (raw.logo !== undefined && raw.logo !== null) {
        const logo = cleanBrandLogo(raw.logo);
        if (logo) out.logo = logo;
        else push('nav.brand_invalid', 'nav.brand.logo', `nav.brand.logo must be an https:// URL of at most ${NAV_SHELL_LIMITS.MAX_URL} characters or asset:<id> of an uploaded image — dropped.`);
    }
    if (typeof raw.showName === 'boolean') out.showName = raw.showName;
    return Object.keys(out).length ? out : null;
}

/** Pass 1: copy the shell keys of `src` that hold a usable value onto `out`, in NAV_SHELL_KEYS order. */
export function canonNavShell(src: Bag, out: Bag, push: Push): void {
    if (src.header !== undefined && src.header !== null) {
        if (typeof src.header === 'string' && NAV_HEADERS.includes(src.header)) out.header = src.header;
        else push('nav.value_invalid', 'nav.header', `nav.header ${JSON.stringify(src.header)} is invalid — dropped. Legal: ${NAV_HEADERS.join(', ')}.`);
    }
    if (src.items !== undefined && src.items !== null) {
        const items = cleanItems(src.items, push);
        if (items) out.items = items;
    }
    if (src.footerText !== undefined && src.footerText !== null) {
        const text = cleanText(src.footerText, NAV_SHELL_LIMITS.MAX_FOOTER);
        if (text) out.footerText = text;
        if (typeof src.footerText === 'string' && src.footerText.trim().length > NAV_SHELL_LIMITS.MAX_FOOTER) push('nav.footer_long', 'nav.footerText', `nav.footerText was cut to ${NAV_SHELL_LIMITS.MAX_FOOTER} characters.`);
    }
    if (src.brand !== undefined && src.brand !== null) {
        const brand = cleanBrand(src.brand, push);
        if (brand) out.brand = brand;
    }
}

/** Pass 2: item screen ids through the rename map; an item whose screen does not exist is dropped. */
export function resolveNavShell(nav: Bag, renameMap: Map<string, string>, validScreenIds: Set<string>, push: Push): void {
    if (!Array.isArray(nav.items)) return;
    const items = (nav.items as NavItem[]).flatMap((item, i) => {
        if (item.screenId === undefined) return [item];
        const resolved = renameMap.get(item.screenId) || item.screenId;
        if (validScreenIds.has(resolved)) return [{ ...item, screenId: resolved }];
        push('nav.item_screen_unknown', `nav.items[${i}].screenId`, `Nav item "${item.label}" pointed at unknown screen ${JSON.stringify(item.screenId)} — dropped.`);
        return [];
    });
    if (items.length) nav.items = items;
    else delete nav.items;
}

/** True when a nav holds any shell key (so it is kept even with the default style and no groups). */
export function hasNavShell(nav: unknown): boolean {
    return isObject(nav) && NAV_SHELL_KEYS.some((key) => nav[key] !== undefined);
}

function itemProblem(item: unknown, screenIds: Set<string>): string | null {
    if (!isObject(item) || !isNavItemId(item.id) || typeof item.label !== 'string' || !item.label || item.label.length > NAV_SHELL_LIMITS.MAX_ITEM_LABEL) return 'must be { id, label (≤40 chars), icon, screenId | url }';
    if (typeof item.screenId === 'string') return screenIds.has(item.screenId) ? null : `names unknown screen ${JSON.stringify(item.screenId)}`;
    return cleanNavUrl(item.url) === item.url ? null : 'needs a screenId or an http(s) url';
}

/** The validator: stored bytes a canonicalizer would have changed are an error. */
export function checkNavShell(nav: unknown, screens: unknown[], pushE: PushFinding): void {
    if (!isObject(nav)) return;
    const err = (code: string, path: string, message: string, hint: string) => pushE({ code, severity: 'error', path, message, hint });
    if (nav.header !== undefined && !NAV_HEADERS.includes(nav.header as string)) err('nav.value_invalid', 'nav.header', `nav.header must be one of ${NAV_HEADERS.join(', ')}.`, `Got ${JSON.stringify(nav.header)}.`);
    if (nav.items !== undefined) {
        if (!Array.isArray(nav.items) || nav.items.length > NAV_SHELL_LIMITS.MAX_ITEMS) {
            err('nav.items_invalid', 'nav.items', `nav.items must be an array of at most ${NAV_SHELL_LIMITS.MAX_ITEMS} items.`, 'Each item is { id, label, icon, screenId | url }.');
        } else {
            const ids = new Set(screens.filter(isObject).map((s) => s.id).filter((id): id is string => typeof id === 'string'));
            nav.items.forEach((item, i) => {
                const problem = itemProblem(item, ids);
                if (problem) err('nav.item_invalid', `nav.items[${i}]`, `Nav item ${problem}.`, 'Point it at a screen id, or give an http(s) address.');
            });
        }
    }
    if (nav.footerText !== undefined && cleanText(nav.footerText, NAV_SHELL_LIMITS.MAX_FOOTER) !== nav.footerText) err('nav.value_invalid', 'nav.footerText', `nav.footerText must be text of at most ${NAV_SHELL_LIMITS.MAX_FOOTER} characters.`, 'Keep the footer to one short line.');
    if (nav.brand !== undefined && !sameJsonValue(cleanBrand(nav.brand, () => {}), nav.brand)) err('nav.brand_invalid', 'nav.brand', 'nav.brand must be { name?, logo?, showName? } in its stored form.', 'A logo is an https:// URL or asset:<id>.');
}
