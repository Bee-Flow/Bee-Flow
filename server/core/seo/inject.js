/**
 * Splice a rendered head and body into the SPA shell.
 *
 * The shell already carries a <title> and a <meta name="description"> — the
 * app's own defaults ("Bee Flow - AI" / "Chat with AI agents powered by Bee
 * Flow"). Those must be REMOVED, not merely followed by better ones: two
 * <title> elements is undefined behaviour, and scrapers commonly take the
 * first. Leaving them in place would keep exactly the bug this is fixing.
 */

const { esc } = require('./html');

// A BCP-47-shaped tag and nothing else.
//
// `lang` is spliced into an attribute of a document served to anonymous
// visitors, and it does not come from the URL: when a page has no locale
// prefix it is `cms_default_locale`, stored data that the CMS admin API
// writes. Anything that is not shaped like a language tag is not one, so it
// is REPLACED rather than escaped — escaping a payload would leave a document
// declaring `lang="en&quot;&gt;<script…"`, which is inert but still a lie
// about the document's language.
const LANG_RE = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/;

// Only the tags we are about to replace. Everything else in <head> — the
// importmap, the font links, the theme bootstrap — is left untouched.
const STRIP_PATTERNS = [
    /<title>[\s\S]*?<\/title>\s*/i,
    /<meta\s+name=["']description["'][^>]*>\s*/i,
    /<link\s+rel=["']icon["'][^>]*>\s*/i,
];

/**
 * @param {string} shell   the built index.html
 * @param {object} parts
 * @param {string} parts.head  tags to insert before </head>
 * @param {string} parts.body  HTML to place inside #root
 * @param {string} parts.lang  the locale for <html lang>
 * @returns {string}
 */
function injectIntoShell(shell, { head = '', body = '', lang = 'en' } = {}) {
    let html = shell;

    for (const re of STRIP_PATTERNS) html = html.replace(re, '');

    // <html lang> was hardcoded to "en" in index.html and never updated at
    // runtime, so Dutch pages were served inside a document declaring English.
    //
    // A function replacer, not a template string: in a replacement STRING the
    // `$` sequences are special, so a stored locale containing `$1` or `` $` ``
    // would splice part of the shell back in.
    const safeLang = LANG_RE.test(String(lang || '')) ? String(lang) : 'en';
    html = html.replace(
        /<html\b([^>]*)\blang=["'][^"']*["']/i,
        (_m, attrs) => `<html${attrs}lang="${esc(safeLang)}"`,
    );

    if (head) {
        html = html.includes('</head>')
            ? html.replace('</head>', `    ${head}\n  </head>`)
            : html;
    }

    if (body) {
        // React's createRoot().render() replaces the children of #root, so
        // this markup is transient by design — it exists for the crawler and
        // for first paint. It is the same content, not a bot-only variant.
        html = html.replace('<div id="root"></div>', `<div id="root">${body}</div>`);
    }

    return html;
}

module.exports = { injectIntoShell };
