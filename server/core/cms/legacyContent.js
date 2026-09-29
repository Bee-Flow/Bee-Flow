/**
 * The legacy keyed `content` shape the public marketing renderer expects.
 *
 * Extracted from routes/cms.js so it has exactly ONE implementation. It is now
 * used twice: by `GET /api/cms/site`, and by routes/publicRender.js to inline
 * the same payload into the server-rendered shell. If those two ever produced
 * different objects the page would render one way on first paint and another
 * once React took over, so sharing the function is not tidiness — it is the
 * thing that makes the inlined bootstrap safe.
 *
 * Pure: depends only on the `eff` payload handed to it.
 */

/**
 * Convert the v2 effective payload into the legacy keyed `content` object
 * the older marketing renderer (and RootPathGate at "/") expect. Each
 * enabled block is added under its type key, and a `blocks[]` array is
 * also emitted so the new renderer can render in panel order.
 *
 * Per-block `style` overrides are preserved on the blocks[] entries so
 * the renderer can apply the same visual customizations on the public
 * site as inside the admin preview.
 */
function synthesizeLegacyContent(eff) {
    const out = {};
    if (eff.header) {
        // navLinks / ctaHref: Header.jsx reads flat `{label, href}` and
        // `data.ctaHref`, but resolveLinksInTree leaves the storage shape
        // (`link: {href, target?, rel?}`) on each entry. Flatten here so
        // the public site sees the same shape the admin preview produces
        // via buildPreviewContent — otherwise every nav link would be
        // silently dropped and the CTA would fall back to '/app'.
        //
        // The page list is no longer attached: nav is fully owned by the
        // user via Site chrome → Nav links, so Header.jsx never reads
        // data.pages anymore.
        out.header = {
            ...eff.header,
            // logo passes through via the spread; Header.jsx prefers
            // logo.text and logo.src when present, falling back to the
            // legacy logoText / letter-avatar otherwise.
            navLinks: (eff.header.nav || []).map(n => {
                const item = {
                    label: n.label,
                    href:  n.link?.href || '#',
                    ...(n.link?.target ? { target: n.link.target } : {}),
                    ...(n.link?.rel    ? { rel:    n.link.rel    } : {}),
                    // Dropdown children get the same flat shape; their
                    // `link.href` was already resolved by resolveLinksInTree
                    // when getEffective walked the header tree.
                    children: (n.children || []).map(c => ({
                        label: c.label,
                        href:  c.link?.href || '#',
                        ...(c.link?.target ? { target: c.link.target } : {}),
                        ...(c.link?.rel    ? { rel:    c.link.rel    } : {}),
                    })),
                };
                // Mega-menu (columns) dropdown — additive, only emitted when
                // the user switched the dropdown to "columns". Mirrors
                // buildPreviewContent in the admin preview (previewContent.js)
                // exactly so the live site renders the same mega menu the
                // editor shows: Header.jsx readDropdown() checks
                // dropdown.layout === 'columns' and renders each item's
                // label/href/description/icon (+ target/rel from the item's
                // "open in new tab" flag). Item links were already resolved
                // to {href, ...} by resolveLinksInTree, same as n.link above.
                if (n.dropdown?.layout === 'columns') {
                    item.dropdown = {
                        layout: 'columns',
                        columns: (n.dropdown.columns || []).map(col => ({
                            heading: col.heading || '',
                            items: (col.items || []).map(mi => ({
                                label:       mi.label || '',
                                href:        mi.link?.href || '#',
                                description: mi.description || '',
                                icon:        mi.icon || '',
                                ...(mi.openInNewTab
                                    ? { target: '_blank', rel: 'noopener noreferrer' }
                                    : {}),
                            })),
                        })),
                    };
                }
                return item;
            }),
            // Header buttons (multi-CTA) — same flat {label, href, style,
            // target?, rel?} shape Header.jsx renders. Per-button label
            // typography (labelFont / labelSize / labelColor) is forwarded
            // verbatim so the renderer can apply inline overrides without
            // re-reading the storage shape.
            ctas: (eff.header.ctas || []).map(cta => ({
                id: cta.id,
                label: cta.label,
                href:  cta.link?.href || '/app',
                style: cta.style || 'primary',
                labelFont:  cta.labelFont  || '',
                labelSize:  Number.isFinite(cta.labelSize) ? cta.labelSize : 0,
                labelColor: cta.labelColor || '',
                ...(cta.link?.target ? { target: cta.link.target } : {}),
                ...(cta.link?.rel    ? { rel:    cta.link.rel    } : {}),
            })),
            activeSlug: eff.page?.isHomepage ? '' : (eff.page?.slug || ''),
        };
    }
    if (eff.footer) {
        // Flatten column links + socials the same way buildPreviewContent
        // does for the admin preview — Footer.jsx reads `link.href` and
        // `social.href` directly. Without this, every footer link would
        // ship to live with `href` undefined and render as a non-clickable
        // <a>.
        out.footer = {
            ...eff.footer,
            brand: {
                logoText: eff.footer.brandText,
                blurb: eff.footer.blurb,
                showDot: eff.footer.showBrandDot === true,
            },
            columns: (eff.footer.columns || []).map(c => ({
                heading: c.heading,
                links: (c.links || []).map(l => ({
                    label: l.label,
                    href:  l.link?.href || '#',
                    ...(l.link?.target ? { target: l.link.target } : {}),
                    ...(l.link?.rel    ? { rel:    l.link.rel    } : {}),
                })),
            })),
            socials: (eff.footer.socials || []).map(s => ({
                platform: s.platform,
                href:     s.link?.href || '#',
                ...(s.link?.target ? { target: s.link.target } : {}),
                ...(s.link?.rel    ? { rel:    s.link.rel    } : {}),
            })),
        };
    }
    // Site-wide cookie banner — passes through verbatim. Its `text` blob
    // already carries every locale, so the renderer picks the visitor's
    // language; no flattening or link resolution needed here.
    if (eff.cookieBanner) out.cookieBanner = eff.cookieBanner;
    // Site-wide announcement bar — same deal as the cookie banner: one
    // per-locale `text` blob, no links to resolve (linkUrl is a plain URL
    // string), so it passes through verbatim.
    if (eff.announcement) out.announcement = eff.announcement;
    // Page title + SEO for the client-side <head> manager (useCmsHead).
    // These fields were editable (and translatable) in the admin but never
    // rendered publicly. Locale overrides are already merged into eff.page
    // by resolveEffective, so the translated metaTitle/metaDescription land
    // here for non-default locales too. The ?v=2 shape carries them via
    // `page` directly.
    out.pageTitle = eff.page?.title || '';
    out.seo = eff.page?.seo || {};
    // Embed design inside content so the public-site renderer at "/" picks
    // it up via the existing RootPathGate pass-through (no App.jsx change
    // needed). The renderer reads initialContent.design for non-preview
    // mounts; preview mode still uses the postMessage payload's design.
    if (eff.design) out.design = eff.design;
    // Per-page chrome visibility. Stored on the page index entry by
    // updatePageMeta; the renderer hides Header/Footer when set. Default
    // false so pages that pre-date the flag still show both.
    out.hideHeader = !!eff.page?.hideHeader;
    out.hideFooter = !!eff.page?.hideFooter;
    const enabledBlocks = (eff.page?.blocks || []).filter(b => b.enabled !== false);
    out.blocks = enabledBlocks.map(b => ({
        id: b.id,
        type: b.type,
        enabled: true,
        content: b.content || {},
        style: b.style || {},
    }));
    for (const b of enabledBlocks) {
        out[b.type] = { enabled: true, ...(b.content || {}) };
    }
    return out;
}

module.exports = { synthesizeLegacyContent };
