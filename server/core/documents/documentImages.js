// @typecheck
/**
 * Whose stored pictures a presentation shows, for the person looking at it.
 *
 * A deck's pictures are storage keys under the uploader's own prefix
 * (`users/<id>/...`), and the storage reader of a render only opens the
 * reader's own (services/presentationRenderer.js makeUserImageResolver). For a
 * deck of one's own that is right. For a deck filed into a project it is not:
 * Bob, a member, opening Anna's deck would get every one of her pictures left
 * out, on screen and in the PDF and .pptx, and Anna would lose Bob's.
 *
 * The rule here: a key under ANOTHER person's prefix is read when that person
 * put it into THIS document themselves, i.e. the oldest revision of the
 * document holding the key is theirs. Not "any key of the owner": a project
 * editor could then write `users/<owner>/<anything>` into the outline and read
 * the owner's other files through the renderer. A key nobody put into a saved
 * revision (a draft previewed before saving) opens the reader's own storage
 * only, as before. The caller has already checked that the reader may read the
 * document.
 *
 * The answer is kept across renders (makeAuthorCache): a deck's live preview
 * renders on every pause in typing, and asking the history for every picture
 * each time read the whole history again and again.
 */

'use strict';

const USER_KEY = /^users\/([^/]+)\//;

/** The spellings a key can have in a stored outline: as is, and as a proxy URL's path. */
function spellingsOf(key) {
    const encoded = key.split('/').map((segment) => encodeURIComponent(segment)).join('/');
    return encoded === key ? [key] : [key, encoded];
}

/** How long an answer from the history is trusted before it is asked again. */
const ANSWER_TTL_MS = 5 * 60 * 1000;
const MAX_ANSWERS = 5000;

/**
 * What the history said about a picture in a document, kept ACROSS renders:
 * a deck's live preview renders on every pause in typing, and each lookup
 * reads revisions. Holds ids and revision numbers only, never content.
 *
 *   { found: { createdBy } }  the oldest revision holding it. Revisions are
 *                             only added after it, so this stays the answer;
 *                             it is asked again after ANSWER_TTL_MS anyway
 *                             (a pruned or deleted revision changes it).
 *   { through: n }            no revision up to number n holds it: the next
 *                             render reads only the revisions saved since.
 *
 * @param {{ ttlMs?: number, max?: number, now?: () => number }} [opts]
 */
function makeAuthorCache({ ttlMs = ANSWER_TTL_MS, max = MAX_ANSWERS, now = Date.now } = {}) {
    /** @type {Map<string, { found?: { createdBy: string|null }, through?: number, at: number }>} */
    const answers = new Map();
    const idOf = (/** @type {string} */ documentId, /** @type {string} */ key) => `${documentId}\n${key}`;
    return {
        now,
        /** @param {string} documentId @param {string} key */
        get(documentId, key) {
            const answer = answers.get(idOf(documentId, key));
            if (!answer) return null;
            if (now() - answer.at > ttlMs) { answers.delete(idOf(documentId, key)); return null; }
            return answer;
        },
        /** @param {string} documentId @param {string} key @param {{ found?: { createdBy: string|null }, through?: number, at: number }} answer */
        set(documentId, key, answer) {
            const id = idOf(documentId, key);
            answers.delete(id);
            answers.set(id, answer);
            while (answers.size > max) answers.delete(answers.keys().next().value);
        },
    };
}

/** @type {ReturnType<typeof makeAuthorCache> | null} */
let shared = null;
/** The one cache the renders of this process share. */
function sharedAuthorCache() {
    if (!shared) shared = makeAuthorCache();
    return shared;
}

/**
 * @param {object} args
 * @param {string} args.readerId
 * @param {{ id: string, userId?: string|null }} args.doc                       the document being rendered
 * @param {(documentId: string, needles: string[], opts?: { afterSeq?: number|null }) => Promise<{ createdBy: string|null } | null>} args.firstAuthorOf
 * @param {(documentId: string) => Promise<number|null>} [args.revisionSeqOf]  the latest revision's number; without it nothing is kept across renders
 * @param {(userId: string) => (ref: any) => Promise<string|null>} args.resolverFor  one person's storage reader
 * @param {ReturnType<typeof makeAuthorCache>} [args.cache]  answers kept across renders (default: this render only)
 * @returns {(ref: any) => Promise<string|null>}
 */
function makeDocumentImageResolver({ readerId, doc, firstAuthorOf, revisionSeqOf, resolverFor, cache = makeAuthorCache() }) {
    const own = resolverFor(readerId);
    /** @type {Map<string, Promise<boolean>>} */
    const decided = new Map();
    /** @type {Promise<number|null> | null} */
    let latest = null;
    // Read once per render, BEFORE any lookup: a revision saved meanwhile is
    // then numbered above it and read next time, never skipped.
    const latestSeq = () => {
        if (!latest) latest = revisionSeqOf ? Promise.resolve().then(() => revisionSeqOf(doc.id)).catch(() => null) : Promise.resolve(null);
        return latest;
    };

    /** The oldest revision's author holding `key`, or null; from the cache where it can answer. */
    async function firstHolderOf(/** @type {string} */ key) {
        const known = cache.get(doc.id, key);
        if (known?.found) return known.found;
        const through = await latestSeq();
        const afterSeq = known && typeof known.through === 'number' ? known.through : null;
        if (afterSeq != null && through != null && afterSeq >= through) return null; // nothing saved since
        const found = await firstAuthorOf(doc.id, spellingsOf(key), afterSeq != null ? { afterSeq } : {});
        const at = known ? known.at : cache.now();
        if (found) cache.set(doc.id, key, { found: { createdBy: found.createdBy ?? null }, at });
        else if (through != null) cache.set(doc.id, key, { through, at });
        return found;
    }

    /** @param {string} key @param {string} uploader */
    async function putThereBy(key, uploader) {
        const first = await firstHolderOf(key);
        if (!first) return false;
        // A revision from before authors were recorded: only the owner (or an
        // org admin, for a team template) could write the document then.
        return (first.createdBy || doc.userId || null) === uploader;
    }

    return async function resolveImage(ref) {
        const key = ref && typeof ref === 'object' && !ref.dataUrl && ref.storageKey ? String(ref.storageKey) : null;
        const uploader = key ? USER_KEY.exec(key)?.[1] : null;
        if (!key || !uploader || uploader === String(readerId) || !doc || !doc.id) return own(ref);
        if (!decided.has(key)) decided.set(key, putThereBy(key, uploader).catch(() => false));
        if (!(await decided.get(key))) return null;
        return resolverFor(uploader)(ref);
    };
}

module.exports = { makeDocumentImageResolver, makeAuthorCache, sharedAuthorCache, ANSWER_TTL_MS, _test: { spellingsOf } };
