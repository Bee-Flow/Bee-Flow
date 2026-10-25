// @typecheck
// Version history: snapshotting the current file trio (plus the `data.db`
// blob) into an immutable `webpage_versions` row, listing/reading/deleting
// snapshots, and the auto-version debounce.

const crypto = require('crypto');
const { run, getOne, getAll } = require('../../db');
const storageStore = require('../storageStore');
const { initDB } = require('./schema');
const { SLOTS, VERSIONED_SLOTS, CONTENT_TYPES, keyFor, sha256 } = require('./shared');
const { readAllSlots, copySlotToVersion } = require('./storage');
const { assertWebpageWrite } = require('./bridgeGrants');
const log = require('../../telemetry/log');

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
 * How often the INSERT may retry its number (see _insertVersionRow).
 * Five is ample: every attempt reads a FRESH maximum, so there only need to be as many
 * attempts as there are writers at the same time on the SAME page. In practice that is at
 * most two (the editor's autosave alongside an AI turn by the same person).
 */
const SEQ_INSERT_ATTEMPTS = 5;
const UNIQUE_VIOLATION = '23505';

/**
 * Anything outside the vocabulary is stored as 'manual' — never a free-text column.
 * @param {string} source
 */
function normalizeSource(source) {
    return VERSION_SOURCES.includes(source) ? source : DEFAULT_VERSION_SOURCE;
}

/**
 * Write the metadata row, with a RACE-FREE sequence number.
 *
 * ── THE NUMBER ──────────────────────────────────────────────────────────────
 *
 * `seq` is not read separately and then written, but computed IN the INSERT statement
 * (`INSERT … SELECT COALESCE(MAX(seq),0)+1 …`). That saves a round trip, but it does not
 * solve the race: under READ COMMITTED — the default of this pool — two concurrent
 * transactions see the same maximum and both write v14.
 *
 * What DOES solve it is the unique index `(webpage_id, seq)` from schema.js: the second
 * writer gets 23505, and then this loop tries again. Each attempt reads a fresh maximum,
 * so the second attempt finds the first writer's number and becomes v15.
 *
 * ── WHY NO LOCK ─────────────────────────────────────────────────────────────
 *
 * The alternative is `SELECT … FOR UPDATE` on the `webpages` row, which puts the writers
 * neatly in a queue. But the caller has by then already made four server-side copies to
 * object storage (copySlotToVersion above), and a row lock held across network I/O to
 * RustFS would silently stall every other save on the same page at the first slow copy.
 * Colliding is rare and cheap to recover from here; waiting is not.
 *
 * ── WHAT IF THE NUMBER DOES NOT SUCCEED ────────────────────────────────────
 *
 * After SEQ_INSERT_ATTEMPTS it rethrows. Writing a snapshot without a number would look
 * attractive, but then a row would appear in the history that could never be called "v…"
 * while nothing seemed to go wrong; the callers here catch the error and log it (the
 * autosave is best-effort). Failing loudly is the honest outcome.
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
 * @param {any} [hashes] - optional pre-computed { htmlSha, cssSha, jsSha, contentLength }
 *                          taken from the webpage row to avoid re-hashing
 * @param {string} [source] - 'manual' (default) | 'ai' | 'published' | 'restore'.
 *                          Last positional argument on purpose: the four pre-W2
 *                          call sites keep their exact behaviour without being
 *                          touched.
 * @param {object} [opts] - W4, after `source` for the same reason.
 * @param {string|null} [opts.actorUserId] - WHO made this version. Defaults to
 *                          `userId`: every write path to a webpage goes via the
 *                          owner, so that is the honest default. An explicit `null`
 *                          means "not determinable" and comes back in the UI as an
 *                          unknown maker.
 * @param {number|null} [opts.lineDelta] - the net line difference of the edit this
 *                          snapshot belongs to, or nothing if it was not measured.
 *                          NOT 0 when in doubt: 0 is the statement "nothing changed".
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
    // `undefined` means "the caller said nothing about it" and falls back to the owner; an
    // explicit `null` means "not determinable" and stays null. Those two must not coincide —
    // otherwise an old call site that knows nothing would quietly name the owner as maker.
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
                try { await storageStore.deleteFile(k); } catch (_) { log.warn('version object could not be deleted from storage', _); }
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
 * Write a `webpage_versions` snapshot from the given files, WITHOUT touching
 * the page's `current/` objects (design D16): a deploy's prepare phase writes
 * the incoming release here, the commit then pins it (setPublishedVersion),
 * and converge writes `current/` last. Same object layout as createVersion
 * (`versions/{vid}/<slot>`), so every reader of a snapshot reads it unchanged.
 *
 * On a managed page this needs the deploy's capability (`managedWrite`).
 *
 * @param {string} webpageId
 * @param {string} ownerId   the page's owner: the objects live under their prefix
 * @param {{ html?: string, css?: string, js?: string, db?: Buffer|null }} files
 *        a missing or empty slot writes no object (an empty slot reads as '')
 * @param {{ managedWrite?: { deploymentId?: string }|null, summary?: string,
 *           source?: string, actorUserId?: string|null }} [opts]
 *        `source` defaults to 'published': the snapshot a release pins is never pruned
 */
async function createVersionSnapshotFromFiles(webpageId, ownerId, files = {}, opts = {}) {
    await initDB();
    await assertWebpageWrite(webpageId, ['files'], { managedWrite: opts.managedWrite || null });
    if (!storageStore.isAvailable()) {
        throw new Error('RustFS not configured — cannot persist webpage files');
    }
    const id = crypto.randomUUID();
    const f = files && typeof files === 'object' ? files : {};
    /** @type {Record<string, string>} */
    const shas = {};
    let contentLength = 0;
    for (const slot of SLOTS) {
        const text = typeof f[slot] === 'string' ? f[slot] : '';
        shas[slot] = text ? sha256(text) : '';
        if (!text) continue;
        const buf = Buffer.from(text, 'utf8');
        contentLength += buf.length;
        await storageStore.uploadFile(keyFor(ownerId, webpageId, slot, id), buf, CONTENT_TYPES[slot]);
    }
    if (Buffer.isBuffer(f.db) && f.db.length > 0) {
        await storageStore.uploadFile(keyFor(ownerId, webpageId, 'db', id), f.db, CONTENT_TYPES.db);
    }
    const kind = normalizeSource(opts.source || 'published');
    const actorUserId = opts.actorUserId === undefined ? (ownerId || null) : (opts.actorUserId || null);
    const seq = await _insertVersionRow([
        id, webpageId, String(opts.summary || 'Release'), shas.html, shas.css, shas.js,
        contentLength, kind, actorUserId, null,
    ]);
    return {
        id, webpageId, seq, summary: String(opts.summary || 'Release'),
        htmlSha: shas.html, cssSha: shas.css, jsSha: shas.js,
        contentLength, source: kind, actorUserId,
    };
}

/**
 * The W4 fields of one row, with the "unknown is not zero" rule in one place.
 *
 * `seq` and `line_delta` come back as NULL on every row from before their column (and
 * `line_delta` also on rows where nothing could be measured). They are therefore NOT
 * flattened with `|| 0`: 0 is a number that asserts something.
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
 * @param {string} userId
 * @param {string | null} versionId
 */
async function getVersion(userId, versionId) {
    await initDB();
    const r = await getOne('SELECT * FROM webpage_versions WHERE id = $1', [versionId]);
    if (!r) return null;
    const trio = await readAllSlots(userId, r.webpage_id, versionId);
    const contentLength = parseInt(r.content_length) || 0;
    // ARE THE BYTES STILL THERE? `readSlot` answers with '' both for "empty" and for "the
    // object is not there", so a snapshot whose objects had vanished from storage read as an
    // EMPTY file — and Restore wrote that emptiness over the live page, while the confirmation
    // had just promised you could undo it. The row knows how many bytes should be there; that
    // is the only independent answer we have.
    const bytesFound = (trio.html || '').length + (trio.css || '').length + (trio.js || '').length;
    const readable = !(contentLength > 0 && bytesFound === 0);
    return {
        id: r.id,
        webpageId: r.webpage_id,
        summary: r.summary || '',
        contentLength,
        createdAt: r.created_at ? new Date(r.created_at).toISOString() : null,
        source: normalizeSource(r.source),
        // `false` means: the row exists, but its content is gone. Never treat it silently as an
        // empty snapshot.
        readable,
        ...mapVersionFacts(r),
        ...trio,
    };
}

// Delete a version. When `webpageId` is supplied the lookup + delete are scoped
// to that webpage so a caller can't remove another tenant's version by guessing
// its id (defense in depth behind the route's ownership check). The RustFS
// objects are keyed by (userId, webpageId, slot, versionId).
/**
 * @param {string} userId
 * @param {string | null} versionId
 */
async function deleteVersion(userId, versionId, webpageId = null, { managedWrite = null } = {}) {
    await initDB();
    const r = webpageId
        ? await getOne('SELECT * FROM webpage_versions WHERE id = $1 AND webpage_id = $2', [versionId, webpageId])
        : await getOne('SELECT * FROM webpage_versions WHERE id = $1', [versionId]);
    if (!r) return false;
    // The snapshot a managed page's audience reads is the deploy's (it pinned
    // it); deleting it would leave the stage serving nothing.
    const page = await getOne('SELECT published_version_id FROM webpages WHERE id = $1', [r.webpage_id]);
    if (page && page.published_version_id === r.id) {
        await assertWebpageWrite(r.webpage_id, ['publishedVersionId'], { managedWrite });
    }
    await run('DELETE FROM webpage_versions WHERE id = $1', [r.id]);
    // Delete the version's RustFS objects (text slots + the snapshotted DB)
    for (const slot of VERSIONED_SLOTS) {
        const k = keyFor(userId, r.webpage_id, slot, versionId);
        try { await storageStore.deleteFile(k); } catch (_) { log.warn('version object could not be deleted from storage', _); }
    }
    return true;
}

/**
 * Has it been quiet long enough to write a new automatic row?
 *
 * `source` is timed PER SOURCE, and that is no detail. Since W4 the AI arm writes one row per
 * turn unconditionally; if this question looked at the last row of WHICHEVER source, then every
 * conversation with a turn every one or two minutes — the normal pace — would permanently stop
 * the clock of the manual autosave. An edit that someone made BY HAND in the Code tab then no
 * longer got its own restore point: exactly the argument with which the debounce was removed
 * from the AI path, now turned against the manual side.
 *
 * @param {string} webpageId
 * @param {string|null} [source] look only at rows of this source; `null` looks at all rows
 *   (the old behaviour, for callers that have no source)
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
    createVersionSnapshotFromFiles,
    getVersions,
    getVersion,
    getVersionMeta,
    deleteVersion,
    shouldAutoVersion,
    VERSION_SOURCES,
    MAX_VERSIONS_PER_WEBPAGE,
};
