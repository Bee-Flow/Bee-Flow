// @typecheck
'use strict';

/** LIKE wildcards in user text are literal. */
const escapeLike = (w) => w.replace(/[\\%_]/g, '\\$&');

/**
 * The text filter of a document library query.
 *
 * A fillable-document search (the builders' discovery tools) matches every
 * word, in any order, so "acme invoice" finds "Invoice Acme Group". The plain
 * library list keeps its phrase match: its notebook branch shares the phrase
 * bind, which is why the phrase is returned too.
 *
 * @param {unknown} query
 * @param {boolean} everyWord  match each word separately
 * @param {(value: string) => string} bind  adds a SQL parameter, returns its `$n`
 * @returns {{ clauses: string[], phrase: string }}  `phrase` is '' unless bound
 */
function librarySearch(query, everyWord, bind) {
    const text = String(query || '').slice(0, 200).trim();
    const words = everyWord ? text.split(/\s+/).filter(Boolean).slice(0, 8) : [];
    const clause = (p) => `(d.name ILIKE ${p} OR d.description ILIKE ${p})`;
    if (words.length > 1) {
        const clauses = words.map((w) => clause(bind('%' + escapeLike(w) + '%')));
        return { clauses, phrase: '' };
    }
    if (!text) return { clauses: [], phrase: '' };
    const phrase = bind('%' + escapeLike(text) + '%');
    return { clauses: [clause(phrase)], phrase };
}

module.exports = { librarySearch };
