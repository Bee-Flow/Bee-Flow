// @typecheck
/**
 * stores/kb/sourcePlan.js: which sources a knowledge base's unassigned
 * documents (documents.source_id IS NULL, i.e. rows that predate the source
 * model) need. Pure, no database access. Shared by the kb-sources-backfill
 * migration and by KbSourcesStore.adoptOrphanDocuments (the lazy adoption when
 * a KB's sources are listed), so both use the same find-or-create keys.
 */

const DEFAULT_UPLOAD_NAME = 'Uploaded files';
const DEFAULT_TEXT_NAME = 'Text snippet';

/** documents.source_type values that get a first-class source kind. */
const NATIVE_KINDS = Object.freeze({ upload: 'upload', text: 'text', web: 'webpage' });

/** @param {unknown} value @param {number} [max] */
function truncate(value, max = 200) {
    const s = String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
    return s.length > max ? s.slice(0, max) : s;
}

function originOf(url) {
    try { return new URL(String(url)).origin; } catch (_) { return null; }
}

function hostOf(url) {
    try { return new URL(String(url)).hostname; } catch (_) { return null; }
}

/**
 * Decide which sources a KB's unassigned documents need — pure, so the shape
 * of the backfill can be asserted without a database.
 *
 * @param {Array<{id:string,title:string,source_type:string,source_uri:string}>} docs
 * @returns {Array<{kind:string,name:string,config:object,configMatch:object,documentIds:string[]}>}
 */
function planSourcesForKb(docs) {
    const plan = [];
    const uploads = [];
    const webByKey = new Map();   // key → { config, configMatch, name, ids }
    const legacyByType = new Map(); // source_type → ids

    for (const doc of docs || []) {
        const sourceType = String(doc.source_type || 'text');
        const kind = NATIVE_KINDS[sourceType];

        if (kind === 'upload') {
            uploads.push(doc.id);
            continue;
        }

        if (kind === 'text') {
            const name = truncate(doc.title) || DEFAULT_TEXT_NAME;
            plan.push({
                kind: 'text',
                name,
                // documentId keys the source to THIS row (so a re-run finds it
                // again); title is what the wrapper route matches on, and jsonb
                // containment makes `{title}` match `{title, documentId}`.
                config: { title: name, documentId: doc.id },
                configMatch: { documentId: doc.id },
                documentIds: [doc.id],
            });
            continue;
        }

        if (kind === 'webpage') {
            const url = doc.source_uri || null;
            const origin = url ? originOf(url) : null;
            // Group per origin first; a group of one collapses to that page's
            // own URL below, so a single ingested page keeps its exact address.
            const key = origin || `url:${url || doc.id}`;
            if (!webByKey.has(key)) {
                webByKey.set(key, { origin, urls: [], titles: [], ids: [] });
            }
            const bucket = webByKey.get(key);
            bucket.urls.push(url);
            bucket.titles.push(doc.title);
            bucket.ids.push(doc.id);
            continue;
        }

        if (!legacyByType.has(sourceType)) legacyByType.set(sourceType, []);
        legacyByType.get(sourceType).push(doc.id);
    }

    if (uploads.length > 0) {
        plan.push({
            kind: 'upload',
            name: DEFAULT_UPLOAD_NAME,
            config: {},
            // An empty match means "any upload source of this KB" — there is
            // exactly one by construction, and `config @> '{}'` finds it.
            configMatch: {},
            documentIds: uploads,
        });
    }

    for (const bucket of webByKey.values()) {
        if (bucket.ids.length === 1) {
            const url = bucket.urls[0];
            const name = truncate(bucket.titles[0]) || hostOf(url) || truncate(url) || 'Web page';
            plan.push({
                kind: 'webpage',
                name,
                config: url ? { url } : {},
                configMatch: url ? { url } : {},
                documentIds: bucket.ids,
            });
            continue;
        }
        // More than one page from the same origin: that was a crawl.
        const origin = bucket.origin;
        plan.push({
            kind: 'webpage',
            name: hostOf(origin) || truncate(origin) || 'Website',
            config: { url: origin, crawl: { maxPages: bucket.ids.length } },
            configMatch: { url: origin },
            documentIds: bucket.ids,
        });
    }

    for (const [sourceType, ids] of legacyByType.entries()) {
        plan.push({
            kind: 'legacy',
            name: sourceType,
            config: { sourceType },
            configMatch: { sourceType },
            documentIds: ids,
        });
    }

    return plan;
}

module.exports = { planSourcesForKb, truncate, DEFAULT_UPLOAD_NAME, DEFAULT_TEXT_NAME };
