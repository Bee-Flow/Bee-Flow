// Translatable-content enumeration for the CMS — THE single client copy of
// the rules deciding which leaves of block/chrome content are text that can
// be translated.
//
// KEEP IN SYNC with server/core/cmsTranslate.js (DENY_KEYS / DENY_SUFFIX /
// value heuristics) — the manual translation list, the locale coverage
// numbers and the AI translate must all agree on the same field set. The
// server file's header points back here (it used to point at
// TranslationPanel.jsx, which now consumes this module).

import { BLOCK_EDITORS } from './editors';
import { getLocalePath } from './localeMerge';
import type { CmsPageDoc, CmsSiteDoc, CmsLocaleOverrides } from './panel/cmsPanelTypes';

export type FieldPath = (string | number)[];
export interface FoundString { fieldPath: FieldPath; source: string }
type RowTarget =
    | { type: 'chrome'; path: FieldPath }
    | { type: 'seo'; field: string }
    | { type: 'block'; blockId: string; fieldPath: FieldPath };
export interface TranslatableRow {
    key: string;
    label: string;
    source: string;
    value: string | undefined;
    target: RowTarget;
    /** a media address: shown for review, never part of the coverage count, never AI translated */
    media?: boolean;
}
export interface TranslatableGroup { key: string; title: string; icon: string; rows: TranslatableRow[]; blockId?: string }

const DENY_KEYS = new Set([
    'id', 'kind', 'type', 'slug', 'src', 'href', 'url', 'link', 'anchor',
    'path', 'pageId', 'page', 'target', 'rel', 'icon', 'platform',
    'code', 'codeRight', 'popupEmbed', 'embed', 'iframe',
    'planType', 'defaultInterval', 'enableToggle', 'interval',
    'layout', 'columnLayout', 'verticalAlign', 'mediaPosition', 'mediaSize',
    'backgroundVariant', 'background', 'gradient', 'theme', 'radius',
    'number', 'enabled', 'noIndex', 'ogImage', 'favicon', 'role', 'value',
    'style', 'align', 'variant', 'srcDark', 'frame',
    // Motion and rich media (issue 244): asset keys, language codes and fixed
    // vocabularies the renderers switch on. `duration` and `label` are prose.
    'poster', 'captionsLang', 'fit', 'position', 'overlay', 'tilt', 'numeral',
    // roadmap items: `status` is a fixed vocabulary the renderer buckets on
    // ('shipped' | 'beta' | 'building' | 'exploring'). Translated to 'bèta'
    // it matches no bucket and the item silently disappears from the page.
    // Its prose counterpart, `statusLabels`, is NOT denied and does translate.
    'status',
    // A/B experiment bookkeeping (server: cmsTranslate.js): a translated name
    // splits the report per language, an invalid one switches the test off.
    'abKey', 'abGoal',
]);
const DENY_SUFFIX = /(Style|Color|Font|Align|Size|Variant|Url|Src|Id|Link)$/;

export function isDeniedKey(k: unknown): boolean {
    if (typeof k !== 'string') return false;
    return DENY_KEYS.has(k) || DENY_SUFFIX.test(k);
}

export function isTranslatableValue(s: string): boolean {
    const t = s.trim();
    if (!t) return false;
    if (/^#[0-9a-fA-F]{3,8}$/.test(t)) return false;
    if (/^(https?:|mailto:|tel:|data:|\/|#)/i.test(t)) return false;
    return true;
}

// Walk content emitting { fieldPath, source } for every translatable leaf.
export function collectStrings(node: unknown, path: FieldPath, out: FoundString[]): void {
    if (Array.isArray(node)) {
        node.forEach((el: unknown, i: number) => collectStrings(el, [...path, i], out));
        return;
    }
    if (node && typeof node === 'object') {
        for (const [k, v] of Object.entries(node)) {
            if (isDeniedKey(k)) continue;
            collectStrings(v, [...path, k], out);
        }
        return;
    }
    if (typeof node === 'string' && isTranslatableValue(node)) out.push({ fieldPath: path, source: node });
}

// Per-language media: the addresses of a media slot (an object with its own
// `src`) that may differ per language. Only keys the default content already
// carries are offered, so the editor preview (which merges by base keys, like
// localeMerge) shows exactly what the public site serves. The server accepts a
// poster even when the default has none (cms_set_locale_override).
const MEDIA_ADDRESS_KEYS = ['src', 'srcDark', 'poster', 'captionsSrc'] as const;

export function collectMedia(node: unknown, path: FieldPath, out: FoundString[]): void {
    if (Array.isArray(node)) {
        node.forEach((el: unknown, i: number) => collectMedia(el, [...path, i], out));
        return;
    }
    if (!node || typeof node !== 'object') return;
    const rec = node as Record<string, unknown>;
    if (typeof rec.src === 'string') {
        for (const key of MEDIA_ADDRESS_KEYS) {
            const v = rec[key];
            if (typeof v === 'string' && (key === 'src' ? v.trim() !== '' : true)) {
                out.push({ fieldPath: [...path, key], source: v });
            }
        }
    }
    for (const [k, v] of Object.entries(rec)) {
        if (v && typeof v === 'object' && !(MEDIA_ADDRESS_KEYS as readonly string[]).includes(k)) collectMedia(v, [...path, k], out);
    }
}

/** A stored override value is only text when it is a string; anything else counts as untranslated. */
function asText(v: unknown): string | undefined {
    return typeof v === 'string' ? v : undefined;
}

function humanize(key: unknown): string {
    return String(key)
        .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
        .replace(/[_-]+/g, ' ')
        .replace(/^\w/, c => c.toUpperCase());
}

// Friendlier names for the most common field keys — additive over the
// humanized fallback, so unknown paths still get a sensible label.
const LABELS: Record<string, string> = {
    lead: 'Lead paragraph',
    eyebrow: 'Eyebrow (small heading)',
    blurb: 'Tagline',
    brandText: 'Brand name',
    logoText: 'Brand name',
    loginLabel: 'Login button',
    copyright: 'Copyright line',
    ctaLabel: 'Button label',
    emptyText: 'Empty-state text',
    successTitle: 'Confirmation title',
    successBody: 'Confirmation text',
    submitLabel: 'Submit button',
    heading: 'Heading',
    subheading: 'Subheading',
    body: 'Body text',
    label: 'Label',
    text: 'Text',
    title: 'Title',
    description: 'Description',
    example: 'Example',
    summary: 'Summary',
    caption: 'Caption',
    alt: 'Image alt text',
    src: 'Media address for this language (image or clip)',
    srcDark: 'Dark-theme image for this language',
    poster: 'Clip poster for this language',
    captionsSrc: 'Captions file for this language',
    placeholder: 'Placeholder',
    message: 'Message',
    accept: 'Accept button',
    decline: 'Decline button',
    privacyLabel: 'Privacy link label',
};

// "Feature #2 · Title" — item positions first, friendly key name last.
export function labelForPath(fieldPath: FieldPath): string {
    const lastKey = [...fieldPath].reverse().find((s): s is string => typeof s === 'string');
    const indices = fieldPath.filter((s): s is number => typeof s === 'number');
    const base = (lastKey && LABELS[lastKey]) || (lastKey ? humanize(lastKey) : 'Text');
    return indices.length ? `${base} (#${indices.map(i => i + 1).join('·')})` : base;
}

// ── Row-group builders (pure — rows carry a `target` descriptor) ─────

export function buildPageGroups(page: CmsPageDoc | null | undefined, pageOverride: unknown, siteOverride: unknown): TranslatableGroup[] {
    if (!page) return [];
    const groups: TranslatableGroup[] = [];

    // Page & SEO group. Title lives in the SITE override (pageTitles); SEO in
    // the PAGE override — both routed via their target descriptors.
    const metaRows: TranslatableRow[] = [];
    if (typeof page.title === 'string' && page.title.trim()) {
        metaRows.push({
            key: 'page:title',
            label: 'Page title',
            source: page.title,
            value: asText(getLocalePath(siteOverride, ['pageTitles', page.id])),
            target: { type: 'chrome', path: ['pageTitles', page.id] },
        });
    }
    for (const f of ['metaTitle', 'metaDescription'] as const) {
        const src = page.seo?.[f];
        if (typeof src === 'string' && src.trim()) {
            metaRows.push({
                key: `seo:${f}`,
                label: f === 'metaTitle' ? 'Meta title' : 'Meta description',
                source: src,
                value: asText(getLocalePath(pageOverride, ['seo', f])),
                target: { type: 'seo', field: f },
            });
        }
    }
    if (metaRows.length) groups.push({ key: 'meta', title: 'Page & SEO', icon: 'FileText', rows: metaRows });

    for (const block of page.blocks || []) {
        const found: FoundString[] = [];
        collectStrings(block.content, [], found);
        const media: FoundString[] = [];
        collectMedia(block.content, [], media);
        if (!found.length && !media.length) continue;
        const def: { label?: string; icon?: string } = (BLOCK_EDITORS as Record<string, { label?: string; icon?: string }>)[block.type] || {};
        groups.push({
            key: block.id,
            blockId: block.id,
            title: def.label || humanize(block.type),
            icon: def.icon || 'Square',
            rows: [...found, ...media].map((f, i): TranslatableRow => ({
                key: `${block.id}:${f.fieldPath.join('.')}:${i}`,
                label: labelForPath(f.fieldPath),
                source: f.source,
                value: asText(getLocalePath(pageOverride, ['blocks', block.id, 'content', ...f.fieldPath])),
                target: { type: 'block', blockId: block.id, fieldPath: f.fieldPath },
                ...(i >= found.length ? { media: true } : {}),
            })),
        });
    }
    return groups;
}

export function buildSiteGroups(site: CmsSiteDoc | null | undefined, siteOverride: unknown): TranslatableGroup[] {
    const groups: TranslatableGroup[] = [];
    for (const region of ['header', 'footer']) {
        const node = site?.[region as 'header' | 'footer'];
        if (!node) continue;
        const found: FoundString[] = [];
        collectStrings(node, [], found);
        if (!found.length) continue;
        groups.push({
            key: region,
            title: region === 'header' ? 'Header' : 'Footer',
            icon: region === 'header' ? 'PanelTop' : 'PanelBottom',
            rows: found.map((f, i) => ({
                key: `${region}:${f.fieldPath.join('.')}:${i}`,
                label: labelForPath(f.fieldPath),
                source: f.source,
                value: asText(getLocalePath(siteOverride, [region, ...f.fieldPath])),
                target: { type: 'chrome', path: [region, ...f.fieldPath] },
            })),
        });
    }
    const titleRows: TranslatableRow[] = [];
    for (const p of site?.pages || []) {
        if (typeof p.title === 'string' && p.title.trim()) {
            titleRows.push({
                key: `title:${p.id}`,
                label: p.title,
                source: p.title,
                value: asText(getLocalePath(siteOverride, ['pageTitles', p.id])),
                target: { type: 'chrome', path: ['pageTitles', p.id] },
            });
        }
    }
    if (titleRows.length) groups.push({ key: 'pageTitles', title: 'Page titles', icon: 'Files', rows: titleRows });
    return groups;
}

// ── Site-wide coverage (locale menu) ─────────────────────────────────
//
// "n of m fields have a translation" per locale — computed from the state
// the panel already holds (no extra endpoint). Wording is deliberately soft:
// a filled field is not necessarily a FRESH translation (D3 — overrides
// don't track source-text changes), so never present 100% as "done".
export function coverageForLocale(site: CmsSiteDoc | null | undefined, pages: CmsPageDoc[] | null | undefined, localeOverrides: CmsLocaleOverrides | null | undefined, locale: string): { done: number; total: number } {
    let total = 0;
    let done = 0;
    const siteOv = localeOverrides?.siteByLocale?.[locale] || null;
    for (const g of buildSiteGroups(site, siteOv)) {
        for (const r of g.rows) {
            total += 1;
            if ((r.value || '').trim()) done += 1;
        }
    }
    for (const pageDoc of pages || []) {
        const pageOv = localeOverrides?.pagesByLocale?.[pageDoc.id]?.[locale] || null;
        for (const g of buildPageGroups(pageDoc, pageOv, siteOv)) {
            // buildPageGroups' meta group repeats the page title already
            // counted by buildSiteGroups' pageTitles rows — skip those rows.
            for (const r of g.rows) {
                if (r.key === 'page:title' || r.media) continue;
                total += 1;
                if ((r.value || '').trim()) done += 1;
            }
        }
    }
    return { done, total };
}
