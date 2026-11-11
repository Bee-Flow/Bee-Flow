/**
 * App Studio runtime: the shell options of `definition.nav` (schema 3; the server's rules are
 * server/appStudio/navShell.mts). Read here once for AppShell and its parts:
 *
 *   none        nav.style 'none': no navigation chrome, only the corner menu
 *   headerHidden nav.header 'hidden': no top bar (or phone bar); the corner takes its place
 *   items       nav.items: the app's own links (a screen of the app, or an http(s) address)
 *   footerText  nav.footerText: one line under every screen
 *   brand       nav.brand: the name and logo the shell shows instead of meta.name / design.logoUrl
 *
 * A nav without these keys reads as "nothing set", so the shell draws what it always drew.
 * The address of a link is checked again here (http or https, nothing else), whatever the
 * stored bytes say.
 */

export interface ShellItem {
    id: string;
    label: string;
    icon: string | null;
    screenId?: string;
    url?: string;
}

export interface ShellBrand {
    name?: string;
    logo?: string;
    showName?: boolean;
}

export interface ShellOptions {
    none: boolean;
    headerHidden: boolean;
    items: ShellItem[];
    footerText: string | null;
    brand: ShellBrand | null;
}

type Bag = Record<string, unknown>;

const isObject = (v: unknown): v is Bag => v !== null && typeof v === 'object' && !Array.isArray(v);

/** An absolute http or https address, or null: the only links a nav item may open. */
export function safeLinkUrl(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const lower = value.trim().toLowerCase();
    if (!lower.startsWith('https://') && !lower.startsWith('http://')) return null;
    try {
        const parsed = new URL(value.trim());
        return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.href : null;
    } catch {
        return null;
    }
}

function readItems(raw: unknown, screenIds: Set<string>): ShellItem[] {
    if (!Array.isArray(raw)) return [];
    const out: ShellItem[] = [];
    for (const item of raw.slice(0, 10)) {
        if (!isObject(item) || typeof item.id !== 'string' || typeof item.label !== 'string' || !item.label) continue;
        const icon = typeof item.icon === 'string' && item.icon ? item.icon : null;
        if (typeof item.screenId === 'string') {
            if (screenIds.has(item.screenId)) out.push({ id: item.id, label: item.label, icon, screenId: item.screenId });
            continue;
        }
        const url = safeLinkUrl(item.url);
        if (url) out.push({ id: item.id, label: item.label, icon, url });
    }
    return out;
}

function readBrand(raw: unknown): ShellBrand | null {
    if (!isObject(raw)) return null;
    const out: ShellBrand = {};
    if (typeof raw.name === 'string' && raw.name) out.name = raw.name;
    if (typeof raw.logo === 'string' && raw.logo) out.logo = raw.logo;
    if (typeof raw.showName === 'boolean') out.showName = raw.showName;
    return Object.keys(out).length ? out : null;
}

interface ShellDefinitionLike {
    nav?: unknown;
    screens?: Array<{ id?: unknown }> | null;
}

export function shellOptions(definition: ShellDefinitionLike | null | undefined): ShellOptions {
    const nav = isObject(definition?.nav) ? definition.nav : {};
    const screenIds = new Set((definition?.screens || []).map((s) => (typeof s?.id === 'string' ? s.id : '')).filter(Boolean));
    const footer = typeof nav.footerText === 'string' && nav.footerText.trim() ? nav.footerText : null;
    return {
        none: nav.style === 'none',
        headerHidden: nav.header === 'hidden',
        items: readItems(nav.items, screenIds),
        footerText: footer,
        brand: readBrand(nav.brand),
    };
}
