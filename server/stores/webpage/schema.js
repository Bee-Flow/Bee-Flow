// @typecheck strict
// Webpage-store schema: the DDL for `webpages`, `webpage_sources`,
// `webpage_versions` and `webpage_extra_files`, the lazy column migrations
// bolted on after the original schema, and the one-shot init state every
// other webpage/ module awaits. Leaf module — requires nothing from webpage/.

const { exec } = require('../../db');
const { makeStoreInit } = require('../lib/storeInit');
const { runDdl } = require('../lib/_ddl');
const log = require('../../telemetry/log');

const initDB = makeStoreInit('WebpageStore', _initDB);

async function _initDB() {

    await exec(`
        CREATE TABLE IF NOT EXISTS webpages (
            id TEXT PRIMARY KEY,
            user_id TEXT NOT NULL,
            name TEXT NOT NULL DEFAULT 'Untitled Webpage',
            description TEXT DEFAULT '',
            instructions TEXT DEFAULT '',
            knowledge_base_ids JSONB DEFAULT '[]'::jsonb,
            settings JSONB DEFAULT '{}'::jsonb,
            html_sha256 TEXT DEFAULT '',
            css_sha256 TEXT DEFAULT '',
            js_sha256 TEXT DEFAULT '',
            html_size INTEGER DEFAULT 0,
            css_size INTEGER DEFAULT 0,
            js_size INTEGER DEFAULT 0,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_webpages_user ON webpages(user_id);
        CREATE INDEX IF NOT EXISTS idx_webpages_created ON webpages(created_at DESC);
    `);

    await exec(`
        CREATE TABLE IF NOT EXISTS webpage_sources (
            id TEXT PRIMARY KEY,
            webpage_id TEXT NOT NULL REFERENCES webpages(id) ON DELETE CASCADE,
            type TEXT NOT NULL DEFAULT 'text',
            name TEXT NOT NULL DEFAULT 'Untitled',
            storage_key TEXT,
            file_name TEXT,
            metadata JSONB DEFAULT '{}'::jsonb,
            status TEXT NOT NULL DEFAULT 'processing',
            error TEXT,
            word_count INTEGER DEFAULT 0,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_webpage_sources_webpage ON webpage_sources(webpage_id);
    `);

    await exec(`
        CREATE TABLE IF NOT EXISTS webpage_versions (
            id TEXT PRIMARY KEY,
            webpage_id TEXT NOT NULL REFERENCES webpages(id) ON DELETE CASCADE,
            summary TEXT DEFAULT '',
            html_sha256 TEXT DEFAULT '',
            css_sha256 TEXT DEFAULT '',
            js_sha256 TEXT DEFAULT '',
            content_length INTEGER DEFAULT 0,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_webpage_versions_webpage ON webpage_versions(webpage_id, created_at DESC);
    `);

    // Lazy column migrations via runDdl (stores/lib/_ddl.js). The old comment said
    // every time "column already exists — fine", but the catch also caught a timeout
    // or an aborted lock wait; now every error is collected loudly per statement and
    // the rest carries on.
    await runDdl('webpageSchema', [
        // Lazy migration — `chat_messages` was added after the original schema for
        // per-webpage chat history persistence. Stored as JSONB so we can read/
        // write the full array atomically without RustFS round-trips.
        `ALTER TABLE webpages ADD COLUMN IF NOT EXISTS chat_messages JSONB DEFAULT '[]'::jsonb`,
        // SQLite database slot — sha + size of the at-rest `data.db` blob in RustFS.
        // The DB itself is run server-side by webpageDbStore.
        `ALTER TABLE webpages ADD COLUMN IF NOT EXISTS db_sha256 TEXT DEFAULT ''`,
        `ALTER TABLE webpages ADD COLUMN IF NOT EXISTS db_size INTEGER DEFAULT 0`,
        // Card metadata — emoji icon, accent colour and tagline the AI sets after
        // building/editing a page so the Webpages list shows a visual identity
        // instead of a generic file-code icon. Thumbnail is a small rendered
        // screenshot stored under users/{userId}/webpages/{id}/thumbnail.png; we
        // keep its sha + size in DB for cache-busting and cheap list rendering.
        `ALTER TABLE webpages ADD COLUMN IF NOT EXISTS icon TEXT DEFAULT ''`,
        `ALTER TABLE webpages ADD COLUMN IF NOT EXISTS accent_color TEXT DEFAULT ''`,
        `ALTER TABLE webpages ADD COLUMN IF NOT EXISTS tagline TEXT DEFAULT ''`,
        `ALTER TABLE webpages ADD COLUMN IF NOT EXISTS thumbnail_sha256 TEXT DEFAULT ''`,
        `ALTER TABLE webpages ADD COLUMN IF NOT EXISTS thumbnail_size INTEGER DEFAULT 0`,
        // Publishing — same 3-mode model as agents/KBs: Personal (is_published=false),
        // Entire Org (is_published=true, shared_groups=[]), Specific Groups
        // (is_published=true, shared_groups=[...]). organization_id is set on first
        // publish from the owner's primary org so cross-org leakage is impossible.
        `ALTER TABLE webpages ADD COLUMN IF NOT EXISTS is_published BOOLEAN DEFAULT FALSE`,
        `ALTER TABLE webpages ADD COLUMN IF NOT EXISTS shared_groups TEXT DEFAULT '[]'`,
        `ALTER TABLE webpages ADD COLUMN IF NOT EXISTS organization_id TEXT`,
        `CREATE INDEX IF NOT EXISTS idx_webpages_org_published ON webpages(organization_id, is_published)`,
        // Runtime bridge grants — explicit allowlists for what the page's
        // script.js can invoke on the platform via window.beeflowAI /
        // beeflowAutomations / beeflowIntegrations. JSONB shape:
        //   { ai: { enabled, groundOnPage, defaultTier? },
        //     automations: [ { automationId, label? } ],
        //     integrations: [ { tool, fixedArgs?, label? } ] }
        // Calls run acts-as-author (uses the webpage owner's credentials), so
        // this column is the sole opt-in surface; viewers cannot bypass it.
        `ALTER TABLE webpages ADD COLUMN IF NOT EXISTS bridge_grants JSONB DEFAULT '{"ai":{"enabled":true,"groundOnPage":true},"automations":[],"integrations":[]}'::jsonb`,
        // Solution membership — the project this page is filed into. Soft
        // reference (no FK), nullable, exactly like automations.project_id and
        // studio_apps.project_id: NULL means standalone and owner-only, and
        // deleting a project detaches rather than destroying the page.
        `ALTER TABLE webpages ADD COLUMN IF NOT EXISTS project_id TEXT`,
        `CREATE INDEX IF NOT EXISTS idx_webpages_project ON webpages(project_id) WHERE project_id IS NOT NULL`,
        // ── Publish lifecycle (W2) ──────────────────────────────────────────
        // WHICH snapshot the audience actually reads. `is_published` says a
        // page HAS an audience; this says WHAT that audience gets. Without it
        // "Publish" pinned nothing and every org reader saw the owner's live
        // row — the last keystroke, published or not.
        //
        // NULLable on purpose, no DEFAULT: NULL means "no snapshot pinned",
        // never "version 0". The read path (webpage/access.resolveReadVersion)
        // and the migration webpage-published-version-2026-09 both key off
        // exactly that.
        `ALTER TABLE webpages ADD COLUMN IF NOT EXISTS published_version_id TEXT`,
        // WHERE a version row came from — the same `kind` model versionStore.js
        // has carried for agents since the start ('autosave' | 'published' |
        // 'pre_refine'), because the wound is identical: a pinned snapshot must
        // not be pushed out of history by a burst of automatic ones.
        //   'manual'     an explicit snapshot (POST /:id/versions) or the
        //                5-minute auto-save — the pre-W2 behaviour, hence the
        //                DEFAULT every existing row inherits
        //   'ai'         one assistant turn's snapshot (W4 writes these)
        //   'published'  frozen by PATCH /:id/publish; NEVER pruned
        // NOT NULL with a DEFAULT is safe here: Postgres 11+ fills it without
        // rewriting the table.
        `ALTER TABLE webpage_versions ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'manual'`,
        // ── The address of the public page (W3 step 4) ─────────────────────
        // `slug` is WHERE the page is public: /w/<slug>, unique per instance. NULL is
        // the normal state — a page that has never been public has no address, and that
        // must stay distinguishable from an empty string. The unique index is therefore
        // PARTIAL: Postgres does not count NULLs as duplicates, but '' does, and then the
        // second page without an address could no longer be saved.
        //
        // Note: with access mode `unlisted` the address IS the key. The slug therefore
        // gets a random suffix (stores/webpage/publicAddress.mintSlug) — a guessable
        // /w/prijslijst would make every public page on the installation enumerable.
        `ALTER TABLE webpages ADD COLUMN IF NOT EXISTS slug TEXT`,
        `CREATE UNIQUE INDEX IF NOT EXISTS idx_webpages_slug ON webpages(slug) WHERE slug IS NOT NULL`,
        // WHICH share serves the address — "one share is the address". The N-share model
        // remains in place (webpage_public_shares holds as many as the owner makes); this
        // pointer says which of them is the canonical one. Soft reference, no FK: a
        // withdrawn share leaves a pointer that points at nothing, and that must yield a
        // 404, not a database error. NULL = not public.
        `ALTER TABLE webpages ADD COLUMN IF NOT EXISTS public_share_id TEXT`,
        // ── The version list as READABLE history (W4) ────────────────────
        //
        // `seq` is THE NUMBER the reader sees ("v14"). `created_at` cannot be that
        // number: it is TRANSACTION time, so two rows from one transaction carry the same
        // value and their order relative to each other is undefined — precisely why the
        // prune query next to this also carries `, id` as a tiebreaker (versions.js).
        //
        // NULLABLE, no DEFAULT. A row from before this column has no number, and that is
        // something DIFFERENT from "v0" — the same choice as published_version_id above.
        // The backfill below gives the existing rows a number after all; whatever is still
        // NULL after that, the UI shows as "no number", never as 0.
        `ALTER TABLE webpage_versions ADD COLUMN IF NOT EXISTS seq INTEGER`,
        // One-off backfill. Runs on the first boot after this column over ALL rows (which are
        // then all NULL) and is empty afterwards, because every new row gets its number on
        // INSERT.
        //
        // The numbering starts at `MAX(seq)` of the page and not at 1. In the normal case
        // that maximum is NULL and therefore 0 — identical to "start at 1". But during a
        // rollout an old pod may still write rows WITHOUT seq while a new pod already writes
        // them WITH seq; then starting at 1 would hand out a number that already exists and
        // collide with the unique index below. A higher number for an older row is ugly; a
        // boot that fails loudly on a duplicate number is worse.
        `UPDATE webpage_versions v
            SET seq = b.base + b.rn
           FROM (
                SELECT n.id,
                       ROW_NUMBER() OVER (PARTITION BY n.webpage_id ORDER BY n.created_at, n.id) AS rn,
                       COALESCE(m.max_seq, 0) AS base
                  FROM webpage_versions n
                  LEFT JOIN (SELECT webpage_id, MAX(seq) AS max_seq
                               FROM webpage_versions GROUP BY webpage_id) m
                    ON m.webpage_id = n.webpage_id
                 WHERE n.seq IS NULL
                ) b
          WHERE v.id = b.id AND v.seq IS NULL`,
        // This index is not only an integrity rule — it IS the race mechanism. The number is
        // assigned with `COALESCE(MAX(seq),0)+1` IN the INSERT (versions.js); under READ
        // COMMITTED two concurrent saves see the same maximum and would both write v14. The
        // unique index turns the second writer into a 23505 instead of a duplicate, and the
        // store then tries again with a fresh maximum.
        //
        // PARTIAL on `seq IS NOT NULL`: rows that the backfill did not touch (or a writer
        // that had to supply the number itself) may coexist side by side — NULL is
        // "unknown" here, not a value that collides.
        `CREATE UNIQUE INDEX IF NOT EXISTS idx_webpage_versions_seq
             ON webpage_versions(webpage_id, seq) WHERE seq IS NOT NULL`,
        // WHO made the version. Soft reference, no FK: a deleted account must not take the
        // history of the page with it. NULL = never recorded, and in the UI that is
        // "unknown" — not "you" and not blank (routes/webpages.js decides that;
        // core/webpages/versionFacts.actorOf executes it).
        `ALTER TABLE webpage_versions ADD COLUMN IF NOT EXISTS actor_user_id TEXT`,
        // HOW MUCH changed: the net number of lines of the edit this snapshot belongs to. NULL =
        // not measured (e.g. a publication or a manual snapshot, where nothing changed), and
        // that is something other than 0 lines.
        `ALTER TABLE webpage_versions ADD COLUMN IF NOT EXISTS line_delta INTEGER`,
    ]);

    // Multi-file support — arbitrary additional files under a webpage.
    // The three primary slots (index.html / style.css / script.js) keep their
    // dedicated columns and RustFS keys; this table stores everything else.
    await exec(`
        CREATE TABLE IF NOT EXISTS webpage_extra_files (
            id TEXT PRIMARY KEY,
            webpage_id TEXT NOT NULL REFERENCES webpages(id) ON DELETE CASCADE,
            path TEXT NOT NULL,
            mime_type TEXT NOT NULL DEFAULT 'text/plain',
            is_text BOOLEAN NOT NULL DEFAULT TRUE,
            sha256 TEXT NOT NULL DEFAULT '',
            size INTEGER NOT NULL DEFAULT 0,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_webpage_extra_path ON webpage_extra_files(webpage_id, path);
    `);
    log.info('[WebpageStore] PostgreSQL initialized');
}

module.exports = {
    initDB,
    // An awaitable handle for dependants (webpagePublicShareStore references
    // webpages(id) by FK and must not run its own DDL first). A getter, not a
    // module-load promise: reading the property is what starts the init, so
    // requiring this module creates nothing. Both spellings — awaiting `ready`
    // and calling `initDB()` — are the same memoized promise.
    get ready() { return initDB(); },
};
