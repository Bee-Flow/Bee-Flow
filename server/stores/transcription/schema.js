// @typecheck strict
/**
 * The transcriptions table: its boot DDL and the additive migration ladder,
 * behind one memoised init that every part of the store awaits.
 */

const { exec } = require('../../db');
const { makeStoreInit } = require('../lib/storeInit');
const { runDdl, CODES } = require('../lib/_ddl');
const log = require('../../telemetry/log');

const initDB = makeStoreInit('TranscriptionStore', _initDB);

async function _initDB() {

    await exec(`
        CREATE TABLE IF NOT EXISTS transcriptions (
            id TEXT PRIMARY KEY,
            user_id TEXT NOT NULL,
            organization_id TEXT,
            title TEXT NOT NULL DEFAULT 'Untitled Transcription',
            file_name TEXT,
            language TEXT DEFAULT 'nl',
            duration_seconds INTEGER DEFAULT 0,
            speaker_count INTEGER DEFAULT 0,
            segment_count INTEGER DEFAULT 0,
            shared_with JSONB DEFAULT '[]'::jsonb,
            is_published BOOLEAN DEFAULT false,
            shared_groups JSONB DEFAULT '[]'::jsonb,
            full_text TEXT,
            transcript TEXT,
            segments JSONB DEFAULT '[]'::jsonb,
            speakers JSONB DEFAULT '[]'::jsonb,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );

        CREATE INDEX IF NOT EXISTS idx_transcriptions_user ON transcriptions(user_id);
        CREATE INDEX IF NOT EXISTS idx_transcriptions_created ON transcriptions(created_at DESC);
    `);

    // Migrations — additive and idempotent; old deployments pre-date some columns.
    //
    // Applied INDIVIDUALLY, via runDdl (stores/lib/_ddl.js). This used to be
    // one try around all 26 statements with an empty catch, so a pod that hit
    // a lock-wait on an early ALTER silently skipped every later one and still
    // reported itself initialised — that replica then failed every note create
    // with "column does not exist" until it restarted. runDdl does exactly
    // what the store's own migrate() helper did here (per statement, loudly,
    // carry on) and also serialises through the advisory lock across replicas,
    // so the "tuple concurrently updated" of a concurrent ADD COLUMN IF NOT
    // EXISTS cannot happen any more; should it happen anyway, it is a failure
    // and is simply retried (see below).
    const ddl = await runDdl('transcriptionStore', [
        `ALTER TABLE transcriptions ADD COLUMN IF NOT EXISTS shared_with JSONB DEFAULT '[]'::jsonb`,
        `ALTER TABLE transcriptions ADD COLUMN IF NOT EXISTS summary TEXT DEFAULT ''`,
        `ALTER TABLE transcriptions ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'completed'`,
        `ALTER TABLE transcriptions ADD COLUMN IF NOT EXISTS audio_path TEXT DEFAULT ''`,
        `ALTER TABLE transcriptions ADD COLUMN IF NOT EXISTS provider TEXT DEFAULT 'voxtral'`,
        `ALTER TABLE transcriptions ADD COLUMN IF NOT EXISTS action_items JSONB DEFAULT '[]'::jsonb`,
        `ALTER TABLE transcriptions ADD COLUMN IF NOT EXISTS tags JSONB DEFAULT '[]'::jsonb`,
        // `tags @> '["sales"]'` without this is a sequential scan of every note in
        // the install, run by a background job every time a meeting-tag knowledge
        // source refreshes (K7).
        `CREATE INDEX IF NOT EXISTS idx_transcriptions_tags ON transcriptions USING gin (tags)`,
        `ALTER TABLE transcriptions ADD COLUMN IF NOT EXISTS organization_id TEXT`,
        `ALTER TABLE transcriptions ADD COLUMN IF NOT EXISTS is_published BOOLEAN DEFAULT false`,
        `ALTER TABLE transcriptions ADD COLUMN IF NOT EXISTS shared_groups JSONB DEFAULT '[]'::jsonb`,
        `CREATE INDEX IF NOT EXISTS idx_transcriptions_shared ON transcriptions USING GIN (shared_with)`,
        `CREATE INDEX IF NOT EXISTS idx_transcriptions_org ON transcriptions(organization_id)`,
        `CREATE INDEX IF NOT EXISTS idx_transcriptions_published ON transcriptions(is_published) WHERE is_published = true`,
        `CREATE INDEX IF NOT EXISTS idx_transcriptions_shared_groups ON transcriptions USING GIN (shared_groups)`,
        // Source provenance + dedup. `source` distinguishes plain uploads from
        // Nextcloud / Talk imports; `source_uri` is the canonical dedup key
        // (e.g. talk://<token>/<file>) so the same recording isn't transcribed
        // twice by manual import + auto-ingest. `talk_room_token` drives
        // write-back to the originating conversation.
        `ALTER TABLE transcriptions ADD COLUMN IF NOT EXISTS source TEXT DEFAULT 'upload'`,
        `ALTER TABLE transcriptions ADD COLUMN IF NOT EXISTS source_uri TEXT`,
        `ALTER TABLE transcriptions ADD COLUMN IF NOT EXISTS talk_room_token TEXT`,
        // Partial unique index — NULL source_uri (normal uploads) stays unconstrained.
        `CREATE UNIQUE INDEX IF NOT EXISTS uq_transcriptions_source_uri ON transcriptions(source_uri) WHERE source_uri IS NOT NULL`,
        // Google Meet import — links a note back to its Meet meeting code
        // (mirrors talk_room_token for the "Upcoming meetings" view).
        `ALTER TABLE transcriptions ADD COLUMN IF NOT EXISTS meet_meeting_code TEXT`,
        // Who was in the room, as supplied at capture time. Persisted so
        // reprocessing re-uses the same roster instead of starting blind — it's
        // the strongest input speaker naming has.
        `ALTER TABLE transcriptions ADD COLUMN IF NOT EXISTS attendees JSONB DEFAULT '[]'::jsonb`,
        // Topic chapters [{title, start}] for the player timeline. Raw LLM
        // output — the client validates timestamps before rendering.
        `ALTER TABLE transcriptions ADD COLUMN IF NOT EXISTS chapters JSONB DEFAULT '[]'::jsonb`,
        // Optional per-meeting speaker-count hint supplied at capture (NULL = Auto).
        // Persisted so a reprocess diarizes with the same expectation.
        `ALTER TABLE transcriptions ADD COLUMN IF NOT EXISTS num_speakers INT`,
        // client — which client captured this recording: 'web' | 'android' | 'api'
        // | 'unknown'. The same closed enum as ai_usage_log.client, filled from the
        // X-Beeflow-Client header every client has always sent (see
        // telemetry/requestClient.js).
        //
        // It is here because "is the phone a capture device or a full client?" is a
        // question about recordings, and until this column existed a recording made
        // by walking into a meeting with a phone and one uploaded from a laptop
        // were the same row. Rows created by a background ingest (Nextcloud Talk,
        // a Meet import) have no request behind them and stay 'unknown', which is
        // correct: no client made them.
        `ALTER TABLE transcriptions ADD COLUMN IF NOT EXISTS client TEXT DEFAULT 'unknown'`,
        // Structured artifacts extracted alongside action items (same LLM pass):
        // decisions [{id, text, timestamp}] and questions [{id, text, timestamp,
        // open}]. Raw LLM output validated server-side like action_items.
        `ALTER TABLE transcriptions ADD COLUMN IF NOT EXISTS decisions JSONB DEFAULT '[]'::jsonb`,
        `ALTER TABLE transcriptions ADD COLUMN IF NOT EXISTS questions JSONB DEFAULT '[]'::jsonb`,
        // Durable object-storage key for the saved recording (RustFS/S3). The
        // local audio_path is ephemeral on multi-replica deploys; this is the
        // backstop that keeps replay + re-transcribe working after a restart.
        `ALTER TABLE transcriptions ADD COLUMN IF NOT EXISTS audio_storage_key TEXT`,
        // ── Columns that exist so the LIST query survives encryption ────────
        // The list used to build its preview with LEFT(full_text, 2000), which
        // over an envelope returns the head of a ciphertext. Making the list
        // decrypt whole transcripts instead would turn a 2 KB row into a
        // hundred-kilobyte one, fifty times a page.
        //
        // full_text_snippet_enc holds the same 2000-char preview under the same
        // key. Rows written before it existed have NULL and the list falls back
        // to the SQL expression for exactly those — see
        // stores/transcriptCrypto.js.
        `ALTER TABLE transcriptions ADD COLUMN IF NOT EXISTS full_text_snippet_enc TEXT`,
        `ALTER TABLE transcriptions ADD COLUMN IF NOT EXISTS summary_snippet_enc TEXT`,
        // Exactly the repair sweep's predicate: "has a local file, has no durable
        // copy". Partial, so it stays tiny once the backlog is cleared.
        `CREATE INDEX IF NOT EXISTS idx_transcriptions_audio_path_unstored
                   ON transcriptions(audio_path) WHERE audio_storage_key IS NULL`,
        // Which speakers were named acoustically by a pyannoteAI voiceprint,
        // and how strong the evidence was:
        //   [{speakerId, userId, name, seconds, share, confidence, decision}]
        // Diagnostic + UI badge. Never holds a template, only the outcome.
        `ALTER TABLE transcriptions ADD COLUMN IF NOT EXISTS voiceprint_matches JSONB DEFAULT '[]'::jsonb`,
        // Which summary template wrote this note, and which VERSION of it
        // (core/meetingNotes/summaryStamp.js decides the form: 'builtin:<key>'
        // or the id of a saved template).
        //
        // No NOT NULL and no DEFAULT — and that is the whole point. NULL is a
        // meaningful value: "it is not known which template made this note".
        // Every note from before this column falls under it, and the screen
        // then shows nothing. A default (1, 'general') would turn all those
        // notes into a claim nobody ever checked.
        //
        // The version is stored ALONGSIDE rather than looked up on the
        // template: a template updated after this note is on a higher number
        // today, and showing that number would be a statement about the past
        // read off the present.
        `ALTER TABLE transcriptions ADD COLUMN IF NOT EXISTS summary_template_id TEXT`,
        `ALTER TABLE transcriptions ADD COLUMN IF NOT EXISTS summary_template_version INTEGER`,
        // One-shot cleanup of the retired meeting-bot table + secrets.
        // Idempotent (IF EXISTS) — and through runDdl no longer a silent DROP
        // that bypassed the _schemaQueue.
        `DROP TABLE IF EXISTS meet_bot_sessions`,
        // Project membership (projects/membership.js, kind 'meeting'). NULL is
        // the note as it always was; a set id makes it readable to every member
        // of that collaborative project. Soft reference, like notebooks: a
        // project delete detaches (clearProjectFromTranscriptions), never
        // deletes, and the sweep below clears ids whose project is gone.
        `ALTER TABLE transcriptions ADD COLUMN IF NOT EXISTS project_id TEXT`,
        `CREATE INDEX IF NOT EXISTS idx_transcriptions_project ON transcriptions(project_id, created_at DESC)
            WHERE project_id IS NOT NULL`,
        {
            sql: `UPDATE transcriptions SET project_id = NULL
                WHERE project_id IS NOT NULL AND project_id NOT IN (SELECT id FROM projects)`,
            tolerate: CODES.UNDEFINED_TABLE,
            reden: 'projects table may not exist yet on a cold boot',
        },
    ]);

    // Only claim to be initialised when the schema actually is. THROWING is
    // what makes the retry actually work: the promise memo resets only on a
    // rejection, so a bare `return` would freeze the half-migrated state in a
    // resolved memo (the old behaviour from before U1 — "next call retries" —
    // existed only with the boolean guard).
    if (ddl.failures.length > 0) {
        throw new Error(`${ddl.failures.length} migration(s) failed — retry op de volgende aanroep`);
    }
    log.info('[TranscriptionStore] PostgreSQL initialized');
}

module.exports = { initDB };
