/**
 * The props a `react-component` block hands its component: the stored values,
 * with image and link fields turned into addresses the frame can use.
 *
 * An image field holds a CMS asset key (`cms/…`) or a URL; the frame gets an
 * absolute URL. A link field holds a CMS link object; by the time a section
 * renders it is `{ href, target?, rel? }` on the public site (the server's
 * resolveLinksInTree) or a bare href string in the editor preview
 * (legacyifyLinks, which also renames a key `link` to `href` and `ctaLink` to
 * `ctaHref`). The frame gets the href.
 */
import { resolveAssetUrl } from '../assetUrl';

interface ReactBlockField {
    name: string;
    label?: string;
    type: string;
    options?: string[];
    help?: string;
}

export type BlockProps = Record<string, unknown>;

/** The key legacyifyLinks moves a link to when the prop has one of its special names. */
const PREVIEW_LINK_KEYS: Record<string, string> = { link: 'href', ctaLink: 'ctaHref' };

function baseUrl(): string {
    return typeof window !== 'undefined' && window.location ? window.location.href : 'http://localhost/';
}

function absolute(href: string): string {
    if (!href) return '';
    try {
        return new URL(href, baseUrl()).href;
    } catch {
        return href;
    }
}

/** A stored or resolved link value as an href ('' when there is none). */
export function linkHref(value: unknown): string {
    if (typeof value === 'string') return value;
    if (!value || typeof value !== 'object') return '';
    const v = value as { href?: unknown; kind?: unknown; url?: unknown; anchor?: unknown; path?: unknown };
    if (typeof v.href === 'string') return v.href;
    if (v.kind === 'external' && typeof v.url === 'string') return v.url;
    if (v.kind === 'anchor') return `#${typeof v.anchor === 'string' ? v.anchor : ''}`;
    if (v.kind === 'app') return typeof v.path === 'string' && v.path ? v.path : '/';
    return '';
}

function resolveField(field: ReactBlockField, props: BlockProps): unknown {
    const raw = props[field.name];
    if (field.type === 'image') {
        return typeof raw === 'string' && raw ? absolute(resolveAssetUrl(raw)) : '';
    }
    if (field.type === 'link') {
        const moved = PREVIEW_LINK_KEYS[field.name];
        const value = raw === undefined && moved ? props[moved] : raw;
        const href = linkHref(value);
        return href ? absolute(href) : '';
    }
    return raw;
}

/** The fields of a block, keeping only well-formed entries. */
function blockFields(value: unknown): ReactBlockField[] {
    if (!Array.isArray(value)) return [];
    return value.filter((f): f is ReactBlockField =>
        !!f && typeof f === 'object' && typeof (f as ReactBlockField).name === 'string' && typeof (f as ReactBlockField).type === 'string');
}

/** The props for the frame: every stored prop, image and link fields resolved. */
export function resolveBlockProps(fieldsValue: unknown, propsValue: unknown): BlockProps {
    const props: BlockProps = propsValue && typeof propsValue === 'object' && !Array.isArray(propsValue)
        ? { ...(propsValue as BlockProps) }
        : {};
    const out: BlockProps = { ...props };
    for (const field of blockFields(fieldsValue)) {
        if (field.type === 'image' || field.type === 'link') out[field.name] = resolveField(field, props);
    }
    return out;
}
