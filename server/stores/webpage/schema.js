// @typecheck
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

    // Lazy kolommigraties via runDdl (stores/lib/_ddl.js). Het oude commentaar
    // zei telkens "column already exists — fine", maar de catch ving net zo
    // goed een timeout of afgebroken lock-wait; nu wordt elke fout per
    // statement luid verzameld en draait de rest gewoon door.
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
        // ── Het adres van de publieke pagina (W3 stap 4) ─────────────────────
        // `slug` is WAAR de pagina publiek staat: /w/<slug>, uniek per
        // instantie. NULL is de normale toestand — een pagina die nooit
        // openbaar is geweest heeft geen adres, en dat moet te onderscheiden
        // blijven van een lege string. De unieke index is daarom PARTIEEL:
        // Postgres telt NULL's niet als duplicaat, maar '' wel, en dan zou de
        // tweede pagina zonder adres niet meer op te slaan zijn.
        //
        // Let op: bij toegangsmodus `unlisted` IS het adres de sleutel. De slug
        // krijgt daarom een willekeurig achtervoegsel (stores/webpage/
        // publicAddress.mintSlug) — een raadbaar /w/prijslijst zou elke
        // openbare pagina op de installatie opsombaar maken.
        `ALTER TABLE webpages ADD COLUMN IF NOT EXISTS slug TEXT`,
        `CREATE UNIQUE INDEX IF NOT EXISTS idx_webpages_slug ON webpages(slug) WHERE slug IS NOT NULL`,
        // WELKE share het adres bedient — "één share is het adres". Het
        // N-share-model blijft bestaan (webpage_public_shares houdt er zoveel
        // als de eigenaar maakt); deze wijzer zegt welke daarvan de canonieke
        // is. Zachte verwijzing, geen FK: een ingetrokken share laat een
        // wijzer achter die naar niets wijst, en dat moet 404 opleveren, geen
        // databasefout. NULL = niet openbaar.
        `ALTER TABLE webpages ADD COLUMN IF NOT EXISTS public_share_id TEXT`,
        // ── De versielijst als LEESBARE geschiedenis (W4) ────────────────────
        //
        // `seq` is HET NUMMER dat de lezer ziet ("v14"). `created_at` kan dat
        // nummer niet zijn: dat is TRANSACTIETIJD, dus twee rijen uit één
        // transactie dragen dezelfde waarde en hun onderlinge volgorde is
        // ongedefinieerd — precies de reden dat de prune-query hiernaast al
        // `, id` als tiebreaker draagt (versions.js).
        //
        // NULLABLE, geen DEFAULT. Een rij van vóór deze kolom heeft geen
        // nummer, en dat is iets ANDERS dan "v0" — dezelfde keuze als
        // published_version_id hierboven. De backfill hieronder geeft de
        // bestaande rijen alsnog een nummer; wat daarna nog NULL is, toont de
        // UI als "geen nummer", nooit als 0.
        `ALTER TABLE webpage_versions ADD COLUMN IF NOT EXISTS seq INTEGER`,
        // Eenmalige backfill. Draait bij de eerste boot ná deze kolom over
        // ALLE rijen (die zijn dan allemaal NULL) en is daarna leeg, want elke
        // nieuwe rij krijgt zijn nummer bij de INSERT.
        //
        // De nummering begint bij `MAX(seq)` van de pagina en niet bij 1. In
        // het normale geval is dat maximum NULL en dus 0 — identiek aan "begin
        // bij 1". Maar tijdens een rollout kan een oude pod nog rijen ZONDER
        // seq schrijven terwijl een nieuwe pod ze al mét seq schrijft; dan
        // zou beginnen-bij-1 een nummer uitdelen dat al bestaat en botsen met
        // de unieke index hieronder. Een hoger nummer voor een oudere rij is
        // lelijk; een boot die luid faalt op een dubbel nummer is erger.
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
        // Deze index is niet alleen een integriteitsregel — hij IS het
        // racemechanisme. Het nummer wordt toegekend met
        // `COALESCE(MAX(seq),0)+1` IN de INSERT (versions.js); onder READ
        // COMMITTED zien twee gelijktijdige saves hetzelfde maximum en zouden
        // ze allebei v14 schrijven. De unieke index maakt van die tweede
        // schrijver een 23505 in plaats van een duplicaat, en de store
        // probeert het dan opnieuw met een vers maximum.
        //
        // PARTIEEL op `seq IS NOT NULL`: rijen die de backfill niet raakte
        // (of een schrijver die het nummer moest opgeven) mogen naast elkaar
        // blijven bestaan — NULL is hier "onbekend", geen waarde die botst.
        `CREATE UNIQUE INDEX IF NOT EXISTS idx_webpage_versions_seq
             ON webpage_versions(webpage_id, seq) WHERE seq IS NOT NULL`,
        // WIE de versie maakte. Zachte verwijzing, geen FK: een verwijderd
        // account mag de geschiedenis van de pagina niet meenemen. NULL =
        // nooit vastgelegd, en dat is in de UI "onbekend" — niet "jij" en
        // niet leeg (routes/webpages.js beslist dat, core/webpages/
        // versionFacts.actorOf voert het uit).
        `ALTER TABLE webpage_versions ADD COLUMN IF NOT EXISTS actor_user_id TEXT`,
        // HOEVEEL er veranderde: het netto aantal regels van de bewerking waar
        // deze momentopname bij hoort. NULL = niet gemeten (bv. een publicatie
        // of een handmatige momentopname, waar niets veranderde), en dat is
        // iets anders dan 0 regels.
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
