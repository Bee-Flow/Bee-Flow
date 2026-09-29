/**
 * Retired slug → its replacement.
 *
 * Add to this map rather than deleting a slug outright. A 301 costs one line;
 * a dead URL costs the inbound links and the ranking pointing at it.
 *
 * Kept here rather than in routes/publicRender.js so it stays pure data that
 * the SEO tests can assert against without booting the database.
 */
const LEGACY_SLUGS = {
    /* The three Power Platform comparison pages were merged into one, because
       Copilot Studio, Power Automate and Power Apps are a single licence and a
       single buying decision — see the comment block at the top of the
       comparison section in scripts/content/beeflowSite.js. */
    'copilot-studio-alternative': 'microsoft-alternative',
    'power-automate-alternative': 'microsoft-alternative',
    'power-apps-alternative': 'microsoft-alternative',

    /* /solutions was removed rather than merged — it restated what /platform
       and the demo pages already showed. The URL was indexed and linked, so it
       redirects instead of 404ing. This moves no content: /platform is where a
       reader arriving on the old URL was trying to get to. */
    solutions: 'platform',

    /* The Dutch V1 site. These are not hypothetical: they are the URLs Google
       still lists for "bee flow" — as of 2026-08-06 the sitelinks under the
       beeflow.nl result are /overons, /kennisbank, /prijzen and /notitieboeken,
       carrying V1 copy. Because an unknown slug fell through to the SPA with a
       200, each of them rendered the logged-in app instead of a page, so the
       search result stayed indexed and the visitor landed nowhere useful. Add
       any further ones Search Console reports under Pages ▸ "Crawled – not
       indexed". */
    overons: 'about',
    kennisbank: 'knowledge',
    prijzen: 'pricing',
    notitieboeken: 'notebooks',
};

module.exports = { LEGACY_SLUGS };
