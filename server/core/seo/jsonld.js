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

const { organizationFields } = require('./siteFacts.mts');

/**
 * Organization — site-wide identity. Emitted on every page. Every fact beyond
 * the name comes from the site settings (core/seo/siteFacts.mts): the legal name
 * from the copyright line, address, registration and VAT number from the
 * footer's accountability block, the profiles from the footer socials. A fact
 * the site does not state is left out.
 * @param {{ siteName: string, origin: string, logoUrl?: string, sameAs?: string[],
 *   facts?: import('./siteFacts.mts').SiteFacts | null }} params
 */
function organization({ siteName, origin, logoUrl, sameAs = [], facts = null }) {
    /** @type {Record<string, unknown>} */
    const node = {
        '@type': 'Organization',
        '@id': `${origin}/#organization`,
        name: siteName,
        url: `${origin}/`,
        ...(facts ? organizationFields(facts) : {}),
    };
    if (logoUrl) node.logo = logoUrl;
    const links = [...new Set(sameAs.filter(Boolean))];
    if (links.length) node.sameAs = links;
    return node;
}

/**
 * WebSite — the site itself, so a search engine can tie every page to one name.
 * @param {{ siteName: string, origin: string, inLanguage: string | string[] }} params
 */
function webSite({ siteName, origin, inLanguage }) {
    return {
        '@type': 'WebSite',
        '@id': `${origin}/#website`,
        name: siteName,
        url: `${origin}/`,
        inLanguage,
        publisher: { '@id': `${origin}/#organization` },
    };
}

/**
 * SoftwareApplication — for the pages that describe the product itself, and
 * only on a site whose footer links a licence (siteFacts licenseUrl): that link
 * is what says the site offers software. A site without one gets no
 * SoftwareApplication, so a customer's site never claims a licence or a free
 * offer it does not state.
 *
 * The one offer stated is the free self-hosted edition (price 0): it needs no
 * licence key and is the same on every page. The paid prices live in the
 * plans table and are rendered by the pricing block at request time;
 * hardcoding a number here would reintroduce exactly the drift the "no
 * hardcoded prices" rule exists to prevent, and a wrong price in structured
 * data is worse than none.
 *
 * @param {{ siteName: string, origin: string, licenseUrl: string, description?: string, logoUrl?: string }} params
 */
function softwareApplication({ siteName, origin, licenseUrl, description, logoUrl }) {
    /** @type {{ '@type': string, '@id': string, name: string, applicationCategory: string, operatingSystem: string,
     *   publisher: { '@id': string }, license: string, offers: Record<string, string>, description?: string, image?: string }} */
    const node = {
        '@type': 'SoftwareApplication',
        '@id': `${origin}/#software`,
        name: siteName,
        applicationCategory: 'BusinessApplication',
        operatingSystem: 'Web, Docker, Kubernetes',
        publisher: { '@id': `${origin}/#organization` },
        license: licenseUrl,
        offers: { '@type': 'Offer', price: '0', priceCurrency: 'EUR' },
    };
    if (description) node.description = description;
    if (logoUrl) node.image = logoUrl;
    return node;
}

/**
 * The SoftwareApplication of a product page, or null on any other page and
 * when the site's footer links no licence.
 * @param {{ isProductPage?: boolean, siteName: string, origin: string, description?: string, logoUrl?: string,
 *   facts?: import('./siteFacts.mts').SiteFacts | null }} params
 */
function licensedApplication({ isProductPage, facts, ...rest }) {
    const licenseUrl = facts?.licenseUrl;
    return isProductPage && licenseUrl ? softwareApplication({ ...rest, licenseUrl }) : null;
}

/**
 * WebPage — ties the page to the site and carries the language.
 * @param {{ url: string, title: string, description?: string, locale: string, origin?: string }} params
 */
function webPage({ url, title, description, locale, origin }) {
    /** @type {{ '@type': string, '@id': string, url: string, name: string, inLanguage: string,
     *   isPartOf?: { '@id': string }, description?: string }} */
    const node = {
        '@type': 'WebPage',
        '@id': `${url}#webpage`,
        url,
        name: title,
        inLanguage: locale,
    };
    if (origin) node.isPartOf = { '@id': `${origin}/#website` };
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
    // A switched-off block or item is not on the page, and Google wants the answers visible.
    const items = (blocks || [])
        .filter((block) => block?.type === 'faq' && block.enabled !== false)
        .flatMap((block) => faqQuestions(block.content?.items));
    if (!items.length) return null;
    return { '@type': 'FAQPage', mainEntity: items };
}

/**
 * The visible question/answer pairs of one faq block as Question nodes.
 * @param {unknown} list the block's `content.items`
 * @returns {Array<{ '@type': string, name: string, acceptedAnswer: { '@type': string, text: string } }>}
 */
function faqQuestions(list) {
    /** @type {Array<{ '@type': string, name: string, acceptedAnswer: { '@type': string, text: string } }>} */
    const out = [];
    for (const item of Array.isArray(list) ? list : []) {
        if (!item || item.enabled === false) continue;
        const q = String(item.question || '').trim();
        const a = String(item.answer || '').trim();
        if (q && a) out.push({ '@type': 'Question', name: q, acceptedAnswer: { '@type': 'Answer', text: a } });
    }
    return out;
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
 *   locales?: string[], slug: string, localePrefix?: string, logoUrl?: string, sameAs?: string[],
 *   facts?: import('./siteFacts.mts').SiteFacts | null,
 *   blocks?: import('../../stores/cms/shared').CmsBlock[], isProductPage?: boolean, extraNodes?: unknown[],
 *   breadcrumbTrail?: Array<{ name: string, path: string }> }} ctx
 */
function buildJsonLd(ctx) {
    const { origin, siteName, url, title, description, locale, locales, slug, localePrefix,
        logoUrl, sameAs, facts, blocks, isProductPage, extraNodes, breadcrumbTrail } = ctx;
    const siteLocales = Array.isArray(locales) && locales.length > 1 ? locales : locale;

    /** @type {Array<Record<string, any>>} */
    const graph = [
        organization({ siteName, origin, logoUrl, sameAs: sameAs ?? facts?.profiles ?? [], facts }),
        webSite({ siteName, origin, inLanguage: siteLocales }),
        webPage({ url, title, description, locale, origin }),
    ];
    const app = licensedApplication({ isProductPage, siteName, origin, description, logoUrl, facts });
    if (app) graph.push(app);

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

module.exports = {
    buildJsonLd, faqPage, organization, softwareApplication, breadcrumbs, webSite,
};
