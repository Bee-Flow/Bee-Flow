// @typecheck
const { injectIntoShell } = require('./inject');

/**
 * The answer for a marketing-shaped URL that has no page: the app shell with
 * `noindex` and a 404 (or 410 for a deliberately removed page). The marker
 * header tells nginx this 404 is ours to keep (see the note at the call site).
 * @param {import('express').Response} res
 * @param {string} shell the app shell HTML
 * @param {string} locale
 * @param {boolean} gone true for a deliberately removed page (410)
 */
function sendNotFound(res, shell, locale, gone) {
    res.status(gone ? 410 : 404).type('html').set('Cache-Control', 'no-store').set('X-Beeflow-Render', 'not-found');
    return res.send(injectIntoShell(shell, {
        head: [
            '<title>Page not found — Bee Flow</title>',
            '<meta name="robots" content="noindex, follow">',
        ].join('\n    '),
        body: '',
        lang: locale,
    }));
}

module.exports = { sendNotFound };
