// @typecheck
// Version history: snapshotting the current file trio (plus the `data.db`
// blob) into an immutable `webpage_versions` row, listing/reading/deleting
// snapshots, and the auto-version debounce.

const crypto = require('crypto');
const { run, getOne, getAll } = require('../../db');
const storageStore = require('../storageStore');
const { initDB } = require('./schema');
const { VERSIONED_SLOTS, keyFor } = require('./shared');
const { readAllSlots, copySlotToVersion } = require('./storage');

// ── Version Control ─────────────────────────────────────────────────

const MAX_VERSIONS_PER_WEBPAGE = 200;
const AUTO_VERSION_DEBOUNCE_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Where a snapshot came from (column `webpage_versions.source`, W2). Mirrors
 * versionStore.js' `kind` for agents, including the reason it exists: a
 * deliberate point in time must not be pushed out of history by automatic
 * ones. 'published' is the only value the prune protects — 'ai' rows count
 * against the cap exactly like manual ones (W4's per-turn snapshots).
 */
const VERSION_SOURCES = Object.freeze(['manual', 'ai', 'published', 'restore']);
const DEFAULT_VERSION_SOURCE = 'manual';

/**
 * Hoe vaak de INSERT zijn nummer opnieuw mag proberen (zie _insertVersionRow).
 * Vijf is ruim: elke poging leest een VERS maximum, dus er hoeven alleen zoveel
 * pogingen te zijn als er schrijvers tegelijk op DEZELFDE pagina zitten. Dat
 * zijn er in de praktijk hoogstens twee (de autosave van de editor naast een
 * AI-beurt van dezelfde persoon).
 */
const SEQ_INSERT_ATTEMPTS = 5;
const UNIQUE_VIOLATION = '23505';

/** Anything outside the vocabulary is stored as 'manual' — never a free-text column. */
function normalizeSource(source) {
    return VERSION_SOURCES.includes(source) ? source : DEFAULT_VERSION_SOURCE;
}

/**
 * Schrijf de metadata-rij, met een RACEVRIJ volgnummer.
 *
 * ── HET NUMMER ──────────────────────────────────────────────────────────────
 *
 * `seq` wordt niet apart gelezen en daarna geschreven, maar IN het
 * INSERT-statement berekend (`INSERT … SELECT COALESCE(MAX(seq),0)+1 …`). Dat
 * scheelt een rondje, maar het lost de race niet op: onder READ COMMITTED —
 * de standaard van deze pool — zien twee gelijktijdige transacties hetzelfde
 * maximum en schrijven ze allebei v14.
 *
 * Wat hem WEL oplost is de unieke index `(webpage_id, seq)` uit schema.js: de
 * tweede schrijver krijgt 23505, en dan probeert deze lus het opnieuw. Elke
 * poging leest een vers maximum, dus de tweede poging vindt het nummer van de
 * eerste schrijver terug en wordt v15.
 *
 * ── WAAROM GEEN LOCK ────────────────────────────────────────────────────────
 *
 * Het alternatief is `SELECT … FOR UPDATE` op de `webpages`-rij, wat de
 * schrijvers netjes op een rij zet. Maar de aanroeper heeft dan al vier
 * server-side kopieën naar objectopslag gedaan (copySlotToVersion hierboven),
 * en een rijlock die over netwerk-I/O naar RustFS heen wordt vastgehouden legt
 * bij de eerste trage kopie elke andere save op dezelfde pagina stil. Botsen is
 * hier zeldzaam en goedkoop te herstellen; wachten is dat niet.
 *
 * ── WAT ALS HET NUMMER NIET LUKT ────────────────────────────────────────────
 *
 * Na SEQ_INSERT_ATTEMPTS gooit hij door. Een momentopname zonder nummer
 * schrijven zou aantrekkelijk lijken, maar dan verschijnt er een rij in de
 * geschiedenis die nooit "v…" kan heten terwijl er niets mis leek te gaan; de
 * aanroepers hier vangen de fout al af en loggen hem (de autosave is
 * best-effort). Luid falen is de eerlijke uitkomst.
 */
async function _insertVersionRow(params) {
    let lastErr = null;
    for (let attempt = 0; attempt < SEQ_INSERT_ATTEMPTS; attempt++) {
        try {
            const row = await getOne(
                `INSERT INTO webpage_versions
                     (id, webpage_id, summary, html_sha256, css_sha256, js_sha256,
                      content_length, source, actor_user_id, line_delta, seq)
                 SELECT $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, COALESCE(MAX(seq), 0) + 1
                   FROM webpage_versions WHERE webpage_id = $2
                 RETURNING seq`,
                params
            );
            const seq = parseInt(row?.seq, 10);
            return Number.isFinite(seq) ? seq : null;
        } catch (err) {
            if (err?.code !== UNIQUE_VIOLATION) throw err;
            lastErr = err;
        }
    }
    throw lastErr;
}

/**
 * Snapshot the current trio of files into a new version. Copies the
 * RustFS objects server-side and records a metadata row.
 *
 * @param {string} userId
 * @param {string} webpageId
 * @param {string} summary
 * @param {object} [hashes] - optional pre-computed { htmlSha, cssSha, jsSha, contentLength }
 *                          taken from the webpage row to avoid re-hashing
 * @param {string} [source] - 'manual' (default) | 'ai' | 'published' | 'restore'.
 *                          Last positional argument on purpose: the four pre-W2
 *                          call sites keep their exact behaviour without being
 *                          touched.
 * @param {object} [opts] - W4, achter `source` om diezelfde reden.
 * @param {string|null} [opts.actorUserId] - WIE deze versie maakte. Standaard
 *                          `userId`: elke schrijfweg naar een webpagina loopt
 *                          via de eigenaar, dus dat is de eerlijke default.
 *                          Expliciet `null` betekent "niet vast te stellen" en
 *                          komt in de UI terug als een onbekende maker.
 * @param {number|null} [opts.lineDelta] - het netto regelverschil van de
 *                          bewerking waar deze momentopname bij hoort, of niets
 *                          als er niet gemeten is. NIET 0 bij twijfel: 0 is de
 *                          uitspraak "er veranderde niets".
 */
async function createVersion(userId, webpageId, summary = 'Auto-save', hashes = null, source = DEFAULT_VERSION_SOURCE, opts = {}) {
    await initDB();
    const id = crypto.randomUUID();

    // Copy each slot's current object into the version prefix — text slots
    // plus the SQLite database (if present). copySlotToVersion is a no-op
    // when the source key doesn't exist, so empty slots cost nothing.
    await Promise.all(VERSIONED_SLOTS.map(slot => copySlotToVersion(userId, webpageId, id, slot)));

    let htmlSha = hashes?.htmlSha;
    let cssSha = hashes?.cssSha;
    let jsSha = hashes?.jsSha;
    let contentLength = hashes?.contentLength;
    if (!hashes) {
        const wp = await getOne('SELECT * FROM webpages WHERE id = $1 AND user_id = $2', [webpageId, userId]);
        htmlSha = wp?.html_sha256 || '';
        cssSha = wp?.css_sha256 || '';
        jsSha = wp?.js_sha256 || '';
        contentLength = (parseInt(wp?.html_size) || 0) + (parseInt(wp?.css_size) || 0) + (parseInt(wp?.js_size) || 0);
    }

    const kind = normalizeSource(source);
    // `undefined` betekent "de aanroeper zei er niets over" en valt terug op de
    // eigenaar; een expliciete `null` betekent "niet vast te stellen" en blijft
    // null. Die twee mogen niet samenvallen — anders zou een oude aanroepplek
    // die niets weet stilzwijgend de eigenaar aanwijzen als maker.
    const actorUserId = opts.actorUserId === undefined ? (userId || null) : (opts.actorUserId || null);
    const delta = Number.isFinite(opts.lineDelta) ? Math.trunc(opts.lineDelta) : null;
    const seq = await _insertVersionRow(
        [id, webpageId, summary, htmlSha || '', cssSha || '', jsSha || '', contentLength || 0, kind, actorUserId, delta]
    );

    // Prune oldest versions beyond MAX, deleting their RustFS objects too.
    //
    // THREE things hold this query together; each closes a way the published
    // pointer could end up aiming at a row that no longer exists:
    //
    //   1. `, id` as a tiebreaker. `created_at` defaults to NOW(), which in
    //      Postgres is TRANSACTION time — two rows written in one transaction
    //      carry the identical timestamp and their relative order is then
    //      undefined. OFFSET over an unstable sort can drop a row that is not
    //      actually the oldest, at any n. studioAppStore.writeVersionSnapshot
    //      already spells this out (`ORDER BY created_at DESC, id`).
    //   2. `source <> 'published'` — a frozen snapshot is a deliberate point
    //      in time and never counts against the cap (versionStore.pruneVersions
    //      does the same for agents), so W4's per-turn 'ai' rows cannot bury it.
    //   3. the live pointer, excluded by id. Belt on top of the braces: if a
    //      row was ever pinned while carrying another source, it still survives.
    //      COALESCE keeps the comparison total — no id equals '' — so a NULL
    //      pointer excludes nothing rather than making the whole predicate NULL.
    const pruned = await getAll(
        `SELECT id FROM webpage_versions
         WHERE webpage_id = $1
           AND source <> 'published'
           AND id <> COALESCE((SELECT published_version_id FROM webpages WHERE id = $1), '')
         ORDER BY created_at DESC, id
         OFFSET $2`,
        [webpageId, MAX_VERSIONS_PER_WEBPAGE]
    );
    if (pruned.length > 0) {
        const ids = pruned.map(r => r.id);
        await run(`DELETE FROM webpage_versions WHERE id = ANY($1::text[])`, [ids]);
        for (const vid of ids) {
            for (const slot of VERSIONED_SLOTS) {
                const k = keyFor(userId, webpageId, slot, vid);
                try { await storageStore.deleteFile(k); } catch (_) {}
            }
        }
    }

    return {
        id, webpageId, summary, seq,
        contentLength: contentLength || 0,
        createdAt: new Date().toISOString(),
        source: kind,
        actorUserId,
        lineDelta: delta,
    };
}

/**
 * De W4-velden van één rij, met de "onbekend is niet nul"-regel op één plek.
 *
 * `seq` en `line_delta` komen als NULL terug op elke rij van vóór hun kolom
 * (en `line_delta` óók op rijen waar niets te meten viel). Ze worden dus NIET
 * met `|| 0` afgevlakt: 0 is een getal dat iets beweert.
 */
function mapVersionFacts(r) {
    const seq = parseInt(r.seq, 10);
    const delta = parseInt(r.line_delta, 10);
    return {
        seq: Number.isFinite(seq) ? seq : null,
        actorUserId: r.actor_user_id || null,
        lineDelta: Number.isFinite(delta) ? delta : null,
    };
}

async function getVersions(webpageId, { limit = 50, offset = 0 } = {}) {
    await initDB();
    const rows = await getAll(
        `SELECT id, webpage_id, summary, content_length, created_at, source, seq, actor_user_id, line_delta
         FROM webpage_versions
         WHERE webpage_id = $1
         -- seq als tweede sleutel: created_at is transactietijd, dus twee
         -- rijen uit een transactie zijn gelijk en zouden op hun (willekeurige)
         -- UUID worden geordend; v15 kon dan onder v14 landen. De id blijft
         -- eronder staan zodat de ordening totaal is, ook voor rijen zonder
         -- nummer.
         ORDER BY created_at DESC, seq DESC NULLS LAST, id
         LIMIT $2 OFFSET $3`,
        [webpageId, limit, offset]
    );
    return rows.map(r => ({
        id: r.id,
        webpageId: r.webpage_id,
        summary: r.summary || '',
        contentLength: parseInt(r.content_length) || 0,
        createdAt: r.created_at ? new Date(r.created_at).toISOString() : null,
        // Absent on a row written before the column existed — reported as the
        // column's own default rather than as an empty string, so the history
        // list never has to know the column is young.
        source: normalizeSource(r.source),
        ...mapVersionFacts(r),
    }));
}

/**
 * A version's ROW only — no RustFS round-trip. The cheap question the publish
 * lifecycle asks twice: "does this pin still exist, and does the live row
 * still match it?" Answering that by reading the whole trio out of object
 * storage would make every page open pay for three downloads it throws away.
 *
 * Returns null when the row is gone (pruned, or never existed). Callers MUST
 * treat that as "no published snapshot" — never as "serve the live row".
 */
async function getVersionMeta(versionId) {
    await initDB();
    if (!versionId) return null;
    const r = await getOne(
        `SELECT id, webpage_id, summary, html_sha256, css_sha256, js_sha256, content_length, created_at,
                source, seq, actor_user_id, line_delta
           FROM webpage_versions WHERE id = $1`,
        [versionId]
    );
    if (!r) return null;
    return {
        id: r.id,
        webpageId: r.webpage_id,
        summary: r.summary || '',
        htmlSha: r.html_sha256 || '',
        cssSha: r.css_sha256 || '',
        jsSha: r.js_sha256 || '',
        contentLength: parseInt(r.content_length) || 0,
        createdAt: r.created_at ? new Date(r.created_at).toISOString() : null,
        source: normalizeSource(r.source),
        ...mapVersionFacts(r),
    };
}

/**
 * Get a single version with full file-trio contents (read from RustFS).
 */
async function getVersion(userId, versionId) {
    await initDB();
    const r = await getOne('SELECT * FROM webpage_versions WHERE id = $1', [versionId]);
    if (!r) return null;
    const trio = await readAllSlots(userId, r.webpage_id, versionId);
    const contentLength = parseInt(r.content_length) || 0;
    // ZIJN DE BYTES ER NOG? `readSlot` antwoordt met '' zowel voor "leeg" als
    // voor "het object is er niet", dus een momentopname waarvan de objecten uit
    // de opslag zijn verdwenen las als een LEEG bestand — en Terugzetten schreef
    // die leegte over de levende pagina heen, terwijl de bevestiging net beloofde
    // dat je het kon terugdraaien. De rij weet nog hoeveel bytes er hoorden te
    // staan; dat is het enige onafhankelijke antwoord dat we hebben.
    const bytesFound = (trio.html || '').length + (trio.css || '').length + (trio.js || '').length;
    const readable = !(contentLength > 0 && bytesFound === 0);
    return {
        id: r.id,
        webpageId: r.webpage_id,
        summary: r.summary || '',
        contentLength,
        createdAt: r.created_at ? new Date(r.created_at).toISOString() : null,
        source: normalizeSource(r.source),
        // `false` betekent: de rij bestaat, maar zijn inhoud is weg. Nooit stil
        // als een lege momentopname behandelen.
        readable,
        ...mapVersionFacts(r),
        ...trio,
    };
}

// Delete a version. When `webpageId` is supplied the lookup + delete are scoped
// to that webpage so a caller can't remove another tenant's version by guessing
// its id (defense in depth behind the route's ownership check). The RustFS
// objects are keyed by (userId, webpageId, slot, versionId).
async function deleteVersion(userId, versionId, webpageId = null) {
    await initDB();
    const r = webpageId
        ? await getOne('SELECT * FROM webpage_versions WHERE id = $1 AND webpage_id = $2', [versionId, webpageId])
        : await getOne('SELECT * FROM webpage_versions WHERE id = $1', [versionId]);
    if (!r) return false;
    await run('DELETE FROM webpage_versions WHERE id = $1', [r.id]);
    // Delete the version's RustFS objects (text slots + the snapshotted DB)
    for (const slot of VERSIONED_SLOTS) {
        const k = keyFor(userId, r.webpage_id, slot, versionId);
        try { await storageStore.deleteFile(k); } catch (_) {}
    }
    return true;
}

/**
 * Is het lang genoeg stil geweest om een nieuwe automatische rij te schrijven?
 *
 * `source` klokt PER BRON, en dat is geen detail. De AI-arm schrijft sinds W4
 * onvoorwaardelijk één rij per beurt; keek deze vraag naar de laatste rij van
 * WELKE bron dan ook, dan zette elk gesprek met een beurt per één à twee minuten
 * — het normale tempo — de klok van de handmatige autosave permanent stil. Een
 * bewerking die iemand met de HAND in de Code-tab maakte kreeg dan structureel
 * geen eigen terugzetpunt meer: precies het argument waarmee de debounce uit het
 * AI-pad is gehaald, nu tegen de handmatige kant gekeerd.
 *
 * @param {string} webpageId
 * @param {string|null} [source] alleen naar rijen van deze bron kijken; `null`
 *   kijkt naar alle rijen (het oude gedrag, voor aanroepers die geen bron hebben)
 */
async function shouldAutoVersion(webpageId, source = null) {
    await initDB();
    const latest = source
        ? await getOne(
            `SELECT created_at FROM webpage_versions
             WHERE webpage_id = $1 AND source = $2 ORDER BY created_at DESC LIMIT 1`,
            [webpageId, source],
        )
        : await getOne(
            `SELECT created_at FROM webpage_versions
             WHERE webpage_id = $1 ORDER BY created_at DESC LIMIT 1`,
            [webpageId],
        );
    if (!latest) return true;
    const elapsed = Date.now() - new Date(latest.created_at).getTime();
    return elapsed >= AUTO_VERSION_DEBOUNCE_MS;
}

module.exports = {
    createVersion,
    getVersions,
    getVersion,
    getVersionMeta,
    deleteVersion,
    shouldAutoVersion,
    VERSION_SOURCES,
    MAX_VERSIONS_PER_WEBPAGE,
};
