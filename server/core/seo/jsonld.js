// @typecheck strict
/**
 * schema.org JSON-LD for marketing pages.
 *
 * None of this existed: a repo-wide search for `application/ld+json` returned
 * nothing. The FAQ case is the clearest loss — the `faq` block already stores
 * `{ question, answer }` pairs, which is exactly the shape `FAQPage` wants, so
 * the site had rich-result-eligible data on several pages and emitted none of it.
 *
 * Everything here is DERIVED from content already on the page. Nothing is
 * invented: no aggregateRating, no review count, no price. Structured data that
 * disagrees with the visible page is a manual-action risk, not a ranking win.
 */

/**
 * Organization — site-wide identity. Emitted on every page.
 * @param {{ siteName: string, origin: string, logoUrl?: string, sameAs?: string[] }} params
 */
function organization({ siteName, origin, logoUrl, sameAs = [] }) {
    /** @type {{ '@type': string, '@id': string, name: string, url: string, logo?: string, sameAs?: string[] }} */
    const node = {
        '@type': 'Organization',
        '@id': `${origin}/#organization`,
        name: siteName,
        url: `${origin}/`,
    };
    if (logoUrl) node.logo = logoUrl;
    const links = sameAs.filter(Boolean);
    if (links.length) node.sameAs = links;
    return node;
}

/**
 * SoftwareApplication — for the pages that describe the product itself.
 *
 * `offers` is deliberately omitted. Prices live in the plans table and are
 * rendered by the pricing block at request time; hardcoding a number here
 * would reintroduce exactly the drift the "no hardcoded prices" rule exists
 * to prevent, and a wrong price in structured data is worse than none.
 *
 * @param {{ siteName: string, origin: string, description?: string, logoUrl?: string }} params
 */
function softwareApplication({ siteName, origin, description, logoUrl }) {
    /** @type {{ '@type': string, '@id': string, name: string, applicationCategory: string, operatingSystem: string,
     *   publisher: { '@id': string }, description?: string, image?: string }} */
    const node = {
        '@type': 'SoftwareApplication',
        '@id': `${origin}/#software`,
        name: siteName,
        applicationCategory: 'BusinessApplication',
        operatingSystem: 'Web, Docker, Kubernetes',
        publisher: { '@id': `${origin}/#organization` },
    };
    if (description) node.description = description;
    if (logoUrl) node.image = logoUrl;
    return node;
}

/**
 * WebPage — ties the page to the org and carries the language.
 * @param {{ url: string, title: string, description?: string, locale: string }} params
 */
function webPage({ url, title, description, locale }) {
    /** @type {{ '@type': string, '@id': string, url: string, name: string, inLanguage: string, description?: string }} */
    const node = {
        '@type': 'WebPage',
        '@id': `${url}#webpage`,
        url,
        name: title,
        inLanguage: locale,
    };
    if (description) node.description = description;
    return node;
}

/**
 * FAQPage from any `faq` block on the page.
 *
 * Google requires the answer to be visible on the page. Ours are: the accordion
 * collapses them with CSS but they are in the DOM, and the server-rendered
 * body emits them expanded. Returns null when there is nothing to describe —
 * an empty FAQPage is an invalid-structured-data warning, not a neutral no-op.
 *
 * @param {import('../../stores/cms/shared').CmsBlock[] | null | undefined} blocks
 */
function faqPage(blocks) {
    /** @type {{ '@type': string; name: string; acceptedAnswer: { '@type': string; text: string; }; }[]} */
    const items = [];
    for (const block of blocks || []) {
        if (block?.type !== 'faq') continue;
        for (const item of block.content?.items || []) {
            const q = String(item?.question || '').trim();
            const a = String(item?.answer || '').trim();
            if (q && a) items.push({
                '@type': 'Question',
                name: q,
                acceptedAnswer: { '@type': 'Answer', text: a },
            });
        }
    }
    if (!items.length) return null;
    return { '@type': 'FAQPage', mainEntity: items };
}

/**
 * BreadcrumbList — only meaningful below the homepage.
 * @param {{ origin: string, localePrefix?: string, slug: string, title: string }} params
 */
function breadcrumbs({ origin, localePrefix, slug, title }) {
    if (!slug) return null;
    return {
        '@type': 'BreadcrumbList',
        itemListElement: [
            { '@type': 'ListItem', position: 1, name: 'Home', item: `${origin}${localePrefix || ''}/` },
            { '@type': 'ListItem', position: 2, name: title, item: `${origin}${localePrefix || ''}/${slug}` },
        ],
    };
}

/**
 * Build the whole graph for one page.
 * Returns a single `@graph` document so the nodes can cross-reference by @id.
 *
 * @param {{ origin: string, siteName: string, url: string, title: string, description?: string, locale: string,
 *   slug: string, localePrefix?: string, logoUrl?: string, sameAs?: string[],
 *   blocks?: import('../../stores/cms/shared').CmsBlock[], isProductPage?: boolean, extraNodes?: unknown[],
 *   breadcrumbTrail?: Array<{ name: string, path: string }> }} ctx
 */
function buildJsonLd(ctx) {
    const { origin, siteName, url, title, description, locale, slug, localePrefix,
        logoUrl, sameAs, blocks, isProductPage, extraNodes, breadcrumbTrail } = ctx;

    /** @type {object[]} */
    /** @type {Array<Record<string, any>>} */
    const graph = [
        organization({ siteName, origin, logoUrl, sameAs }),
        webPage({ url, title, description, locale }),
    ];
    if (isProductPage) graph.push(softwareApplication({ siteName, origin, description, logoUrl }));

    const faq = faqPage(blocks);
    if (faq) graph.push(faq);

    // Deeper pages (a blog post) pass their own trail: Home › Blog › Post.
    const crumbs = Array.isArray(breadcrumbTrail) && breadcrumbTrail.length
        ? {
            '@type': 'BreadcrumbList',
            itemListElement: breadcrumbTrail.map((c, i) => ({
                '@type': 'ListItem', position: i + 1, name: c.name, item: `${origin}${c.path}`,
            })),
        }
        : breadcrumbs({ origin, localePrefix, slug, title });
    if (crumbs) graph.push(crumbs);
    for (const node of Array.isArray(extraNodes) ? extraNodes : []) {
        if (node && typeof node === 'object') graph.push(node);
    }

    return { '@context': 'https://schema.org', '@graph': graph };
}

module.exports = { buildJsonLd, faqPage, organization, softwareApplication, breadcrumbs };
