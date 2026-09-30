// @typecheck
/**
 * Transcription Store — PostgreSQL-backed meeting transcription history.
 *
 * Stores transcription results so they can be listed, viewed, renamed,
 * deleted, and published to org groups (mirrors the KB / agent publish
 * model). Read access:
 *   - Owner always
 *   - Published to org: same-org member sees it
 *   - Published with shared_groups: only members of one of those groups
 *   - Filed into a project (project_id): any member of that project, any role
 * Writes stay with the owner, whoever else may read.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { run, getOne, getAll, exec } = require('../db');
const { makeStoreInit } = require('./lib/storeInit');
const { runDdl, CODES } = require('./lib/_ddl');
const { buildUpdate } = require('./lib/sqlBuilder');
// Request-scoped, via AsyncLocalStorage — so a store this deep does not need
// every caller to thread the client down to it. Returns 'unknown' outside a
// request, which is what a background ingest should record.
const { currentClient } = require('../telemetry/requestClient');
// Content-column encryption for this store — policy, key, and the two derived
// columns the list query needs. See stores/transcriptCrypto.js.
const transcriptCrypto = require('./transcriptCrypto');
const { projectRoleOf } = require('./lib/projectRole');
const log = require('../telemetry/log');

// Saved audio lives under server/data/uploads (audio/ + saved-recordings/).
// Deletion only ever unlinks files inside this root — never arbitrary paths.
const UPLOADS_ROOT = path.resolve(__dirname, '../data/uploads');

/**
 * Read a JSONB column that is supposed to hold an array.
 *
 * Every one of these used to be an inline `JSON.parse` with no guard, inside a
 * `rows.map`. A single row whose column held a JSON scalar — `PATCH {"tags":
 * "urgent"}` was enough, since the write side did not validate either — threw
 * and took out the ENTIRE list response, for the owner, for every org member
 * the note was published to, and for super admins. One bad row, everyone's
 * library gone.
 */
function parseJsonArray(value) {
    if (Array.isArray(value)) return value;
    if (value === null || value === undefined || value === '') return [];
    if (typeof value === 'string') {
        try {
            const parsed = JSON.parse(value);
            return Array.isArray(parsed) ? parsed : [];
        } catch (_) {
            return [];
        }
    }
    return [];
}

/** Coerce an inbound array field on the WRITE side, so rows never go bad. */
function toArray(value) {
    return Array.isArray(value) ? value : [];
}

/**
 * ── HET VENSTER VAN EEN REGENERATIE (M4) ────────────────────────────
 *
 * "Opnieuw" leest de notitie, praat daarna minuten met een model en schrijft
 * dán pas. De merge in core/meetingNotes/actionItems.js beschermt wat een
 * mens heeft neergezet — maar alleen rijen die in die MOMENTOPNAME zaten.
 * Wie ondertussen in het transcript-tabblad een regel als besluit vastlegt
 * (de "Opnieuw"-banner staat boven dat tabblad), schrijft in precies dat
 * venster: voor de merge is die rij onzichtbaar en de landende update wist
 * hem. Geen melding, geen undo — en het antwoord toont daarna keurig de
 * werkelijkheid waarin de rij zojuist verdween. Hetzelfde geldt voor een
 * bestaand punt dat iemand in dat venster AFVINKT of overtypt: de merge
 * draaide tegen een momentopname van vóór dat vinkje.
 *
 * Het antwoord daarop hoort NIET in de route: die weet niets van wat er ná
 * zijn read is gebeurd. Het hoort in het SQL van de schrijfactie, want daar
 * is de kolom van dit moment te zien. De regel is: vervang alleen wat er vóór
 * het vertrekpunt van de run al stond; wat erna is ontstaan OF veranderd
 * blijft staan.
 *
 * ── ÉÉN KLOK ────────────────────────────────────────────────────────
 * Zowel het vertrekpunt (`readAt`, meegegeven door getTranscription) als de
 * `createdAt`/`touchedAt` van elke artefactregel komt uit `NOW()` van DEZE
 * database.
 * Node's klok komt er niet aan te pas en de client evenmin: twee klokken die
 * milliseconden uiteenlopen beslissen juist aan de randen van dit venster de
 * verkeerde kant op. Vandaar één vast, lexicografisch vergelijkbaar formaat
 * in plaats van een cast die op een rare waarde kan omvallen.
 *
 * IN MICROSECONDEN, NIET IN MILLISECONDEN. `NOW()` van Postgres loopt in
 * microseconden, en dit formaat gooide er drie cijfers van weg (het was
 * identiek aan JS' toISOString). Twee transacties in dezelfde milliseconde
 * kregen dan dezelfde stempel, en `>` maakt van gelijk "vóór de run": een
 * vinkje dat in dezelfde milliseconde landde als de read van "Opnieuw", werd
 * stil overschreven. Met de volle klok betekent gelijk vrijwel alleen nog:
 * dezelfde transactie (NOW() is het begin daarvan).
 * Stempels van vóór deze regel dragen nog drie cijfers ("…12.345Z"). Tegen
 * een nieuwe vergelijkt dat alleen anders dan de tijd als beide in dezelfde
 * milliseconde vallen, en een oude stempel en een nieuwe read liggen minstens
 * een deploy uit elkaar.
 *
 * GEEN OPTIMISTIC LOCK. Een versiecontrole zou de hele schrijfactie weigeren
 * omdat er érgens iets veranderd is; dat maakt van een geslaagde run van
 * minuten een foutmelding. Een tijdstempel per rij zegt precies genoeg.
 */
const DB_CLOCK_ISO = `to_char(NOW() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
// De stempel voor een rij die al in de kolom stond maar er nog geen draagt:
// geschreven vóór deze regel bestond, door de kale UPDATE van /reprocess, of
// door de INSERT van een auto-import. Zelfde klok, zelfde formaat.
//
// HIER STOND `updated_at`, EN DAT VERBREEDDE. `updated_at` is het moment van
// de vorige schrijfactie op de NOTITIE, en dat ligt ná het vertrekpunt van een
// lopende run zodra er tijdens die run ook maar iets anders op de rij is
// geschreven (een titel PATCHen, een spreker hernoemen, de audio-backfilljob).
// Een ongestempelde AI-rij kreeg dan een stempel BINNEN het venster en
// overleefde als "tijdens de run ontstaan" — precies de rij die "Opnieuw"
// hoort te vervangen, en de gebruiker zag oude AI-punten terugkomen.
//
// `created_at` is het aanmaakmoment van de NOTITIE. Dat ligt per definitie
// vóór elke read van die rij, dus vóór elk mogelijk vertrekpunt, en het
// beweegt nooit meer. Een rij zonder stempel kan niet nieuwer dan het
// vertrekpunt bewezen worden en telt daarmee gegarandeerd als oud — de kant
// waar de gewone merge-regel geldt, die een mens z'n rijen al beschermt.
const ROW_UNSTAMPED_ISO = `to_char(created_at AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

/** Een JSON-scalar in een array-kolom telt als leeg — zelfde regel als parseJsonArray. */
function jsonbArrayOf(expr) {
    return `CASE WHEN jsonb_typeof(${expr}) = 'array' THEN ${expr} ELSE '[]'::jsonb END`;
}

/**
 * De inhoud van één artefactrij ZONDER de twee stempels.
 *
 * Waarmee de vraag "is deze rij daadwerkelijk veranderd" wordt beantwoord: de
 * stempels zelf tellen niet mee, anders zou elke herschrijving zichzelf als
 * wijziging melden. Een rij die geen object is gaat ongemoeid door — die kan
 * de `- 'key'`-operator niet aan, en "onbekend" hoort hier als "veranderd" te
 * eindigen (versmallend: de rij telt dan als tijdens de run aangeraakt).
 */
function artifactRowBody(expr) {
    return `(CASE WHEN jsonb_typeof(${expr}) = 'object'
                  THEN (${expr}) - 'createdAt' - 'touchedAt' ELSE ${expr} END)`;
}

/**
 * De SET-expressie voor één artefactkolom (action_items / decisions / questions).
 *
 * ── TWEE STEMPELS, ÉÉN VRAAG ────────────────────────────────────────
 *   createdAt  wanneer deze rij is ONTSTAAN (blijft staan bij herschrijven).
 *   touchedAt  wanneer deze rij voor het laatst van INHOUD veranderde.
 * Beide van de databaseklok, allebei onbereikbaar voor de client: wat er
 * binnenkomt wordt hier overschreven.
 *
 * Drie delen, in één statement zodat er tussen lezen en schrijven geen venster
 * meer zit:
 *   1. Staat er een rij met DEZELFDE id in de kolom die ná het vertrekpunt van
 *      de run is aangeraakt, dan wint DIE rij en wordt wat de schrijver stuurt
 *      genegeerd.
 *   2. Anders: wat de schrijver stuurt, met de stempels hierboven.
 *   3. Alleen als er een vertrekpunt is: alles wat op dit moment in de kolom
 *      staat, ná dat vertrekpunt is aangeraakt, en niet al in (1)/(2) voorkomt.
 *
 * ── WAAROM DEEL 1 ER IS ─────────────────────────────────────────────
 * Deel 3 alleen redt rijen die tijdens de run zijn ONTSTAAN. Een bestaand
 * AI-punt dat iemand tijdens diezelfde run AFVINKT houdt zijn oude `createdAt`
 * en staat gewoon in de verse lijst — beide voorwaarden van deel 3 falen, dus
 * de minuten oude momentopname van de merge overschreef het vinkje weer. Dat
 * is dezelfde bevinding, alleen onder een andere volgorde: de merge beschermt
 * menselijke invoer die vóór de read gebeurde, dit deel beschermt die van
 * tijdens de run.
 *
 * De hele opgeslagen rij wint, niet een paar velden ervan: welk veld een mens
 * heeft aangeraakt is hier niet te zien, en een verse tijdstempel of assignee
 * kwijtraken op één rij weegt niet op tegen een vinkje of een correctie stil
 * ongedaan maken. De volgende regeneratie ververst hem alsnog.
 */
function artifactColumnSql(column, valuePh, sincePh) {
    const stored = jsonbArrayOf(column);
    const now = `to_jsonb(${DB_CLOCK_ISO})`;
    const unstamped = `to_jsonb(${ROW_UNSTAMPED_ISO})`;
    // "Deze rij is ná het vertrekpunt van de run aangeraakt." Zonder
    // vertrekpunt is er geen venster en is het antwoord altijd nee. Een rij
    // zonder stempel geeft NULL en dus ook nee — onbekend versmalt.
    const touchedDuringTheRun = (expr) => (sincePh ? `(${expr})->>'touchedAt' > ${sincePh}::text` : 'false');
    const keptFromTheRun = sincePh ? `
                UNION ALL
                SELECT kept AS item, 1000000 + k.n AS ord
                  FROM jsonb_array_elements(${stored}) WITH ORDINALITY AS k(kept, n)
                 WHERE ${touchedDuringTheRun('kept')}
                   AND NOT EXISTS (
                       SELECT 1 FROM jsonb_array_elements(${valuePh}::jsonb) AS f(fresh)
                        WHERE fresh->>'id' = kept->>'id')` : '';
    return `(SELECT COALESCE(jsonb_agg(item ORDER BY ord), '[]'::jsonb) FROM (
                SELECT CASE
                         WHEN prev IS NOT NULL AND ${touchedDuringTheRun('prev')} THEN prev
                         ELSE e || jsonb_build_object(
                             'createdAt', COALESCE(prev->'createdAt',
                                 CASE WHEN prev IS NULL THEN ${now} ELSE ${unstamped} END),
                             'touchedAt',
                                 CASE WHEN prev IS NULL THEN ${now}
                                      WHEN ${artifactRowBody('e')} IS DISTINCT FROM ${artifactRowBody('prev')} THEN ${now}
                                      ELSE COALESCE(prev->'touchedAt', ${unstamped}) END)
                       END AS item,
                       w.n AS ord
                  FROM jsonb_array_elements(${valuePh}::jsonb) WITH ORDINALITY AS w(e, n)
                  LEFT JOIN LATERAL (
                       SELECT p FROM jsonb_array_elements(${stored}) AS o(p)
                        WHERE p->>'id' = e->>'id' LIMIT 1
                  ) AS pv(prev) ON TRUE${keptFromTheRun}
            ) AS windowed)`;
}

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
    // with "column does not exist" until it restarted. runDdl geeft precies
    // wat de eigen migrate()-helper hier al deed (per statement, luid, doorgaan)
    // en serialiseert bovendien via de advisory lock over replicas heen — de
    // "tuple concurrently updated" van concurrent ADD COLUMN IF NOT EXISTS kan
    // dan niet meer optreden; gebeurt hij toch, dan is hij een failure en
    // wordt er (zie onder) gewoon opnieuw geprobeerd.
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
        // Welk samenvattingssjabloon deze notitie geschreven heeft, en welke
        // VERSIE daarvan (core/meetingNotes/summaryStamp.js bepaalt de vorm:
        // 'builtin:<key>' of het id van een opgeslagen sjabloon).
        //
        // Geen NOT NULL en geen DEFAULT — en dat is de hele bedoeling. NULL is
        // hier een betekenisvolle waarde: "van deze notitie is niet bekend met
        // welk sjabloon hij gemaakt is". Elke notitie van vóór deze kolom valt
        // daaronder, en het scherm toont dan niets. Een default (1, 'general')
        // zou van al die notities een bewering maken die niemand ooit heeft
        // gecontroleerd.
        //
        // De versie staat ERBIJ in plaats van dat hij bij het sjabloon wordt
        // opgezocht: een sjabloon dat na deze notitie is bijgewerkt staat
        // vandaag op een hoger nummer, en dat nummer erbij tonen zou een
        // uitspraak over het verleden zijn die aan het heden is afgelezen.
        `ALTER TABLE transcriptions ADD COLUMN IF NOT EXISTS summary_template_id TEXT`,
        `ALTER TABLE transcriptions ADD COLUMN IF NOT EXISTS summary_template_version INTEGER`,
        // One-shot cleanup of the retired meeting-bot table + secrets.
        // Idempotent (IF EXISTS) — en via runDdl niet langer een stille DROP
        // die de _schemaQueue passeerde.
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
    // wat de retry echt laat werken: de promise-memo reset alleen op een
    // rejectie, dus een kale `return` zou de half-gemigreerde staat juist
    // vastzetten in een resolved memo (het oude gedrag van vóór U1 — "next
    // call retries" — bestond alleen bij de boolean-guard).
    if (ddl.failures.length > 0) {
        throw new Error(`${ddl.failures.length} migration(s) failed — retry op de volgende aanroep`);
    }
    log.info('[TranscriptionStore] PostgreSQL initialized');
}

// ── CRUD ─────────────────────────────────────────────────

// NOTE: this destructure IS the write contract. A caller can pass anything, but
// only the keys named here reach the INSERT — `sharedWith` was missing for a
// long time, so Google Meet's "share the note with the attendees" feature
// silently discarded its share list on every single import, with no error.
// Adding a column means adding it in THREE places: here, the column list, and
// the values array. A column holding CONTENT means a fourth: the list in
// stores/transcriptCrypto.js, or it goes to disk in plaintext.
async function createTranscription({ userId, organizationId, title, fileName, language, durationSeconds, speakerCount, segmentCount, fullText, transcript, segments, speakers, summary, status, audioPath, provider, actionItems, source, sourceUri, talkRoomToken, meetMeetingCode, attendees, chapters, numSpeakers, audioStorageKey, decisions, questions, tags, sharedWith, client, summaryTemplateId, summaryTemplateVersion, projectId }) {
    await initDB();
    const id = crypto.randomUUID();
    // Content columns are sealed here, before anything reaches the driver. The
    // counters and the preview are computed from the PLAINTEXT first — after
    // encryption there is nothing left to count or truncate.
    const ctx = await transcriptCrypto.resolveTranscriptCrypto(organizationId || null);
    const snippet = transcriptCrypto.buildSnippet(id, fullText || '', ctx);
    const summarySnippet = transcriptCrypto.buildSummarySnippet(id, summary || '', ctx);
    const sealed = transcriptCrypto.encryptRow(id, {
        full_text: fullText || '',
        transcript: transcript || '',
        summary: summary || '',
        segments: JSON.stringify(toArray(segments)),
        speakers: JSON.stringify(toArray(speakers)),
        attendees: JSON.stringify(toArray(attendees)),
        chapters: JSON.stringify(toArray(chapters)),
    }, ctx);
    const { rowCount } = await run(
        `INSERT INTO transcriptions (id, user_id, organization_id, title, file_name, language, duration_seconds, speaker_count, segment_count, full_text, transcript, segments, speakers, summary, status, audio_path, provider, action_items, source, source_uri, talk_room_token, meet_meeting_code, attendees, chapters, num_speakers, audio_storage_key, decisions, questions, tags, shared_with, client, summary_template_id, summary_template_version, full_text_snippet_enc, summary_snippet_enc, project_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28, $29, $30, $31, $32, $33, $34, $35, $36)
         ON CONFLICT (source_uri) WHERE source_uri IS NOT NULL DO NOTHING`,
        [id, userId, organizationId || null, title || fileName || 'Untitled', fileName, language || 'nl', durationSeconds || 0, speakerCount || 0, segmentCount || 0, sealed.full_text, sealed.transcript, sealed.segments, sealed.speakers, sealed.summary, status || 'completed', audioPath || '', provider || 'voxtral', JSON.stringify(toArray(actionItems)), source || 'upload', sourceUri || null, talkRoomToken || null, meetMeetingCode || null, sealed.attendees, sealed.chapters, Number.isFinite(numSpeakers) && numSpeakers >= 1 ? Math.round(numSpeakers) : null, audioStorageKey || null, JSON.stringify(toArray(decisions)), JSON.stringify(toArray(questions)), JSON.stringify(toArray(tags)), JSON.stringify(toArray(sharedWith)), client || currentClient(), summaryTemplateId || null, Number.isInteger(summaryTemplateVersion) ? summaryTemplateVersion : null, snippet, summarySnippet, projectId || null]
    );
    // Lost the race (same source_uri already ingested concurrently) — return the winner.
    if (rowCount === 0 && sourceUri) {
        const existing = await getOne('SELECT id, user_id, organization_id FROM transcriptions WHERE source_uri = $1', [sourceUri]);
        if (existing) {
            log.info(`[TranscriptionStore] Dedup hit for ${sourceUri} → existing ${existing.id}`);
            return { id: existing.id, userId: existing.user_id, organizationId: existing.organization_id || null, dedup: true };
        }
    }
    log.info(`[TranscriptionStore] Created transcription "${title}" (${status || 'completed'}) via ${provider || 'voxtral'} for user ${userId}`);
    return { id, userId, organizationId: organizationId || null, title, fileName, language, durationSeconds, speakerCount, segmentCount, status: status || 'completed', provider: provider || 'voxtral', source: source || 'upload', sourceUri: sourceUri || null, talkRoomToken: talkRoomToken || null, meetMeetingCode: meetMeetingCode || null, projectId: projectId || null, createdAt: new Date().toISOString() };
}

/**
 * Lookup a transcription by its canonical source URI. Used as the cheap
 * pre-check before downloading + transcribing a Nextcloud/Talk recording so
 * the same file isn't processed twice.
 */
/**
 * Rows for a set of on-disk recordings, keyed by their absolute `audio_path`.
 *
 * The repair sweep is disk-first on purpose: on a multi-replica deploy a note's
 * local file exists only on the pod that created it, so asking the DB "which
 * notes lack a durable copy" returns mostly rows this pod cannot help with.
 * Listing the directory and asking about THOSE files is bounded and always
 * actionable. Exact-match is safe because the container path is identical on
 * every pod.
 */
async function getTranscriptionsByAudioPaths(paths) {
    const list = (Array.isArray(paths) ? paths : []).filter(p => typeof p === 'string' && p);
    if (!list.length) return [];
    await initDB();
    return getAll(
        `SELECT id, user_id, audio_path, audio_storage_key, file_name
           FROM transcriptions
          WHERE audio_path = ANY($1::text[])`,
        [list]
    );
}

async function getTranscriptionBySourceUri(sourceUri) {
    if (!sourceUri) return null;
    await initDB();
    return getOne('SELECT id, user_id, organization_id, title FROM transcriptions WHERE source_uri = $1', [sourceUri]);
}

/**
 * Most recent transcription created from a given Talk room token (used by the
 * "Upcoming meetings" view to show a "recorded → note" status). Scoped to the
 * owner so the meetings view only reflects the current user's notes.
 */
async function getTranscriptionByTalkRoomToken(talkRoomToken, userId = null) {
    if (!talkRoomToken) return null;
    await initDB();
    if (userId) {
        return getOne(
            'SELECT id, user_id, title, created_at FROM transcriptions WHERE talk_room_token = $1 AND user_id = $2 ORDER BY created_at DESC LIMIT 1',
            [talkRoomToken, userId],
        );
    }
    return getOne(
        'SELECT id, user_id, title, created_at FROM transcriptions WHERE talk_room_token = $1 ORDER BY created_at DESC LIMIT 1',
        [talkRoomToken],
    );
}

/**
 * Most recent transcription created from a given Google Meet meeting code.
 * Mirrors getTranscriptionByTalkRoomToken — owner-scoped so the meetings view
 * only reflects the current user's notes.
 */
async function getTranscriptionByMeetMeetingCode(meetingCode, userId = null) {
    if (!meetingCode) return null;
    await initDB();
    if (userId) {
        return getOne(
            'SELECT id, user_id, title, created_at FROM transcriptions WHERE meet_meeting_code = $1 AND user_id = $2 ORDER BY created_at DESC LIMIT 1',
            [meetingCode, userId],
        );
    }
    return getOne(
        'SELECT id, user_id, title, created_at FROM transcriptions WHERE meet_meeting_code = $1 ORDER BY created_at DESC LIMIT 1',
        [meetingCode],
    );
}

/**
 * The per-row aggregates the LIBRARY rail needs (Meeting Notes artboard 1a:
 * "27 jul · 1:01 · 14 acties open"), computed in Postgres so a list row never
 * ships the action_items array itself:
 *   actions_total   — how many action items the note carries
 *   actions_open    — how many of those are not done (`done` is a client-set
 *                     flag; compared as text, so a stray "yes" cannot throw
 *                     the way a ::boolean cast on it would — and one bad row
 *                     must never take the whole list down)
 *   failure_reason  — a failed note stores WHY in `summary` (upload.js /
 *                     reprocess.js write `Transcription failed: …` there);
 *                     surfaced under its own name so the client stops
 *                     reading a summary that is not one
 * A non-array `action_items` (a JSON scalar from an unvalidated PATCH) counts
 * as empty, matching parseJsonArray on the read side.
 */
// action_items stays plaintext (see stores/transcriptCrypto.js — it is merged
// in SQL on write), so these two expressions keep working unchanged. The
// failure reason does NOT: it lives in `summary`, which is encrypted, and
// LEFT() over an envelope returns the head of a ciphertext. It is derived in
// Node instead, from the summary the list already carries.
const LIST_AGGREGATES = `
                    COALESCE(jsonb_array_length(CASE WHEN jsonb_typeof(action_items) = 'array' THEN action_items ELSE '[]'::jsonb END), 0)::int AS actions_total,
                    (SELECT COUNT(*) FROM jsonb_array_elements(CASE WHEN jsonb_typeof(action_items) = 'array' THEN action_items ELSE '[]'::jsonb END) AS ai
                      WHERE COALESCE(ai->>'done', 'false') <> 'true')::int AS actions_open`;

async function getTranscriptions(userId, { limit = 50, offset = 0, orgIds = [], userGroupIds = [], isSuperAdmin = false } = {}) {
    await initDB();
    // Super admins (resolveUserOrgIds === null) see every transcription
    // unconditionally — mirrors the bypass that exists in agents/KBs.
    if (isSuperAdmin) {
        const rows = await getAll(
            `SELECT id, user_id, organization_id, title, file_name, language, duration_seconds, speaker_count, segment_count,
                    shared_with, is_published, shared_groups, created_at, updated_at, provider, status, source, talk_room_token, meet_meeting_code, tags, project_id,
                    LEFT(COALESCE(full_text, ''), 2000) AS full_text_snippet,
                    full_text_snippet_enc,
                    LEFT(COALESCE(summary, ''), 400) AS summary_snippet,
                    summary_snippet_enc,${LIST_AGGREGATES}
             FROM transcriptions
             ORDER BY created_at DESC LIMIT $1 OFFSET $2`,
            [limit, offset]
        );
        const byOrg = await transcriptCrypto.resolveForRows(rows);
        return rows.map(r => ({
            ...mapRow(r, transcriptCrypto.ctxForRow(byOrg, r)),
            isOwner: r.user_id === userId, ownerId: r.user_id,
        }));
    }
    // Normal user: own rows + legacy per-user shares + published-to-my-org rows.
    // We build the WHERE clause incrementally so an empty orgIds / userGroupIds
    // never reaches Postgres as ANY('{}'::text[]) / ?| ARRAY[]::text[] — both
    // of which the `pg` driver mishandles in some versions.
    const params = [userId, limit, offset, JSON.stringify([userId])];
    const clauses = [`user_id = $1`, `shared_with @> $4::jsonb`];
    if (Array.isArray(orgIds) && orgIds.length > 0) {
        params.push(orgIds);
        const orgParamIdx = params.length;
        if (Array.isArray(userGroupIds) && userGroupIds.length > 0) {
            params.push(userGroupIds);
            const groupParamIdx = params.length;
            clauses.push(
                `(is_published = true AND organization_id = ANY($${orgParamIdx}::text[]) AND (shared_groups = '[]'::jsonb OR shared_groups ?| $${groupParamIdx}::text[]))`
            );
        } else {
            clauses.push(
                `(is_published = true AND organization_id = ANY($${orgParamIdx}::text[]) AND shared_groups = '[]'::jsonb)`
            );
        }
    }
    const rows = await getAll(
        `SELECT id, user_id, organization_id, title, file_name, language, duration_seconds, speaker_count, segment_count,
                shared_with, is_published, shared_groups, created_at, updated_at, provider, status, source, talk_room_token, meet_meeting_code, tags, project_id,
                LEFT(COALESCE(full_text, ''), 2000) AS full_text_snippet,
                full_text_snippet_enc,
                LEFT(COALESCE(summary, ''), 400) AS summary_snippet,
                summary_snippet_enc,${LIST_AGGREGATES}
         FROM transcriptions
         WHERE ${clauses.join(' OR ')}
         ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
        params
    );
    const byOrg = await transcriptCrypto.resolveForRows(rows);
    return rows.map(r => ({
        ...mapRow(r, transcriptCrypto.ctxForRow(byOrg, r)),
        isOwner: r.user_id === userId, ownerId: r.user_id,
    }));
}

/**
 * The single-row read ACL, as `{ clauses, params }` over `$1 = id`.
 * Factored out so `getTranscription` and `canReadTranscription` cannot drift —
 * a second hand-written copy of this predicate is how "readable" and "actually
 * returned" end up disagreeing.
 */
function buildReadAcl(id, userId, ctx = {}) {
    const acl = readAclClauses(userId, ctx, 1);   // $1 is the id
    return { clauses: acl.clauses, params: [id, ...acl.params] };
}

/**
 * The read predicate on its own, so a LIST can apply the same rule a single
 * row does.
 *
 * `startIdx` is how many placeholders the caller has already used, because a
 * list query binds a tag (and maybe a date) before the ACL. Passing it wrong
 * silently shifts every clause onto the wrong parameter — which for an ACL
 * means comparing `user_id` against a tag name and returning nothing, or
 * worse, against something that matches.
 */
function readAclClauses(userId, { orgIds = [], userGroupIds = [] } = {}, startIdx = 0) {
    const params = [userId, JSON.stringify([userId])];
    const p = (n) => `$${startIdx + n}`;
    const clauses = [`user_id = ${p(1)}`, `shared_with @> ${p(2)}::jsonb`];
    if (Array.isArray(orgIds) && orgIds.length > 0) {
        params.push(orgIds);
        const orgParamIdx = params.length;
        if (Array.isArray(userGroupIds) && userGroupIds.length > 0) {
            params.push(userGroupIds);
            const groupParamIdx = params.length;
            clauses.push(
                `(is_published = true AND organization_id = ANY(${p(orgParamIdx)}::text[]) AND (shared_groups = '[]'::jsonb OR shared_groups ?| ${p(groupParamIdx)}::text[]))`
            );
        } else {
            clauses.push(
                `(is_published = true AND organization_id = ANY(${p(orgParamIdx)}::text[]) AND shared_groups = '[]'::jsonb)`
            );
        }
    }
    return { clauses, params };
}

/**
 * Meetings carrying a tag, that this reader may actually open.
 *
 * ── THE READER IS THE KNOWLEDGE BASE'S OWNER, AND THAT IS THE POINT ─
 * A `meeting_tag` knowledge source (K7) turns "every meeting tagged sales"
 * into documents somebody else can search. That WIDENS who can read those
 * summaries — which is exactly why this applies the same read ACL a person
 * opening one note gets, with the KB owner as the reader, rather than
 * enumerating the tag and trusting the caller. A source in a knowledge base
 * shared with the whole organisation can only ever contain meetings its owner
 * could already open.
 *
 * @param {string} tag
 * @param {string} readerId
 * @param {object} [ctx]  `{ orgIds, userGroupIds, since, limit }`
 */
async function listByTag(tag, readerId, { orgIds = [], userGroupIds = [], since = null, limit = 200 } = {}) {
    await initDB();
    if (!tag || !readerId) return [];
    /** @type {any[]} */
    const params = [JSON.stringify([tag])];
    const where = [`tags @> $1::jsonb`, `status = 'completed'`];
    if (since) {
        params.push(since);
        where.push(`updated_at > $${params.length}`);
    }
    const acl = readAclClauses(readerId, { orgIds, userGroupIds }, params.length);
    params.push(...acl.params);
    where.push(`(${acl.clauses.join(' OR ')})`);
    params.push(Math.min(Math.max(Number(limit) || 200, 1), 1000));

    const rows = await getAll(
        `SELECT id, title, summary, decisions, questions, action_items, tags,
                created_at, updated_at, organization_id, user_id
           FROM transcriptions
          WHERE ${where.join(' AND ')}
          ORDER BY updated_at DESC
          LIMIT $${params.length}`,
        params,
    );
    // This feeds knowledge-base ingestion, so it carries real content columns
    // and has to open them. One context per organisation in the result set.
    const byOrg = await transcriptCrypto.resolveForRows(rows);
    return (rows || []).map((raw) => {
        const r = transcriptCrypto.decryptRow(raw, transcriptCrypto.ctxForRow(byOrg, raw));
        return {
            id: r.id,
            title: r.title || '',
            summary: r.summary || '',
            decisions: parseJsonArray(r.decisions),
            questions: parseJsonArray(r.questions),
            actionItems: parseJsonArray(r.action_items),
            tags: parseJsonArray(r.tags),
            createdAt: r.created_at,
            updatedAt: r.updated_at,
            organizationId: r.organization_id || null,
            userId: r.user_id,
        };
    });
}

/**
 * `read_at` reist mee: het moment waarop DEZE read plaatsvond, van de klok van
 * de database zelf. Een lezer die daarna minutenlang rekent (de regeneratie
 * doet vier LLM-aanroepen voordat hij schrijft) heeft dat moment nodig als
 * vertrekpunt — zie artifactColumnSql. Het staat in dezelfde SELECT als de rij
 * omdat het over die rij gaat, en het komt uit dezelfde bron als de stempels
 * waartegen het straks wordt vergeleken.
 */
async function getTranscription(id, userId, ctx = {}) {
    await initDB();
    if (ctx.isSuperAdmin) {
        const r = await getOne(`SELECT *, ${DB_CLOCK_ISO} AS read_at FROM transcriptions WHERE id = $1`, [id]);
        if (!r) return null;
        return shapeRow(r, userId, await transcriptCrypto.resolveTranscriptCrypto(r.organization_id || null));
    }
    const { clauses, params } = buildReadAcl(id, userId, ctx);
    const r = await getOne(
        `SELECT *, ${DB_CLOCK_ISO} AS read_at FROM transcriptions WHERE id = $1 AND (${clauses.join(' OR ')})`,
        params
    );
    if (r) return shapeRow(r, userId, await transcriptCrypto.resolveTranscriptCrypto(r.organization_id || null));
    // Not readable by the ACL above; it may still be a meeting note filed into
    // a project the caller is a member of. A second read, taken only on a miss,
    // so the common owner path stays one query.
    const filed = await readableThroughProject(id, userId, `*, ${DB_CLOCK_ISO} AS read_at`);
    if (!filed) return null;
    const note = shapeRow(filed.row, userId, await transcriptCrypto.resolveTranscriptCrypto(filed.row.organization_id || null));
    return { ...note, projectRole: filed.role };
}

/**
 * A note filed into a project the caller is a member of (ANY role; reading is
 * all membership buys here), as `{ row, role }`, or null.
 *
 * @param {string} id
 * @param {string} userId
 * @param {string} columns  what to select; the detail read wants the whole row
 */
async function readableThroughProject(id, userId, columns = 'id, project_id') {
    if (!id || !userId) return null;
    const row = await getOne(`SELECT ${columns} FROM transcriptions WHERE id = $1 AND project_id IS NOT NULL`, [id]);
    if (!row) return null;
    const role = await projectRoleOf(userId, row.project_id);
    return role ? { row, role } : null;
}

/**
 * Can `userId` open this note? Same predicate as `getTranscription`, without
 * paying to shape the row.
 *
 * Used by the import dedup paths: a `source_uri` hit means *somebody* already
 * imported this recording, which is not the same as the caller being allowed
 * to read the result.
 */
async function canReadTranscription(id, userId, ctx = {}) {
    if (!id) return false;
    await initDB();
    if (ctx.isSuperAdmin) return true;
    const { clauses, params } = buildReadAcl(id, userId, ctx);
    const r = await getOne(
        `SELECT 1 AS ok FROM transcriptions WHERE id = $1 AND (${clauses.join(' OR ')})`,
        params
    );
    if (r) return true;
    // The same second path getTranscription takes, so "readable" and "actually
    // returned" cannot disagree about a project member.
    return !!(await readableThroughProject(id, userId));
}

/**
 * Shape a FULL row for the detail view.
 *
 * `ctx` decides only how to OPEN what is there — never whether it is encrypted.
 * decryptRow asks each value what it is, so a plaintext row and an encrypted
 * one shape identically and a backfill can run while people are reading.
 *
 * A column that IS an envelope but will not open throws, deliberately. This
 * feeds updateTranscription, which writes back what it read: a silent '' would
 * overwrite a meeting's transcript with nothing.
 */
function shapeRow(r, userId, ctx = transcriptCrypto.PLAINTEXT_CONTEXT) {
    r = transcriptCrypto.decryptRow(r, ctx);
    return {
        ...mapRow(r, ctx),
        fullText: r.full_text || '',
        transcript: r.transcript || '',
        summary: r.summary || '',
        audioPath: r.audio_path || '',
        segments: parseJsonArray(r.segments),
        speakers: parseJsonArray(r.speakers),
        sharedWith: parseJsonArray(r.shared_with),
        sharedGroups: parseJsonArray(r.shared_groups),
        isPublished: !!r.is_published,
        organizationId: r.organization_id || null,
        actionItems: parseJsonArray(r.action_items),
        decisions: parseJsonArray(r.decisions),
        questions: parseJsonArray(r.questions),
        // Het moment van DEZE read, van de databaseklok — het vertrekpunt voor
        // een schrijver die er minuten over doet. null als de query hem niet
        // meegaf, en dan valt de caller terug op `updatedAt` (dezelfde klok).
        readAt: r.read_at || null,
        tags: parseJsonArray(r.tags),
        attendees: parseJsonArray(r.attendees),
        chapters: parseJsonArray(r.chapters),
        numSpeakers: r.num_speakers != null ? Number(r.num_speakers) : null,
        audioStorageKey: r.audio_storage_key || null,
        voiceprintMatches: parseJsonArray(r.voiceprint_matches),
        source: r.source || 'upload',
        sourceUri: r.source_uri || null,
        talkRoomToken: r.talk_room_token || null,
        // Welk sjabloon (en welke versie ervan) deze samenvatting geschreven
        // heeft. null blijft null — het scherm zegt dan niets in plaats van
        // een versie te noemen die het niet kent.
        summaryTemplateId: r.summary_template_id || null,
        summaryTemplateVersion: Number.isInteger(Number(r.summary_template_version)) && Number(r.summary_template_version) > 0
            ? Number(r.summary_template_version)
            : null,
        isOwner: r.user_id === userId,
        ownerId: r.user_id,
    };
}

/**
 * Take exclusive ownership of a note for a (re)processing run.
 *
 * Reprocess used to read the status, then blind-write `processing`, so two
 * concurrent runs both believed they owned the note — a double-click on Retry
 * was enough. Whichever finished LAST won, and a loser that merely errored
 * (e.g. a 429 caused by the other run) wrote `status:'failed'` over the
 * winner's completed note, destroying the generated summary. Both runs were
 * billed in full.
 *
 * The claim is a single conditional UPDATE, so exactly one caller can win even
 * across replicas.
 *
 * @returns {Promise<boolean>} true when this caller now owns the run.
 */
async function claimForProcessing(id, userId) {
    await initDB();
    const { rowCount } = await run(
        `UPDATE transcriptions SET status = 'processing', updated_at = NOW()
          WHERE id = $1 AND user_id = $2 AND status IS DISTINCT FROM 'processing'`,
        [id, userId]
    );
    return rowCount > 0;
}

/**
 * Write the outcome of a run ONLY while this caller still owns it.
 *
 * Guards the mirror image of the race above: a slow failing run must not stamp
 * its error over a note that has since been completed (or re-claimed) by
 * someone else. `status` is part of the predicate, not just the payload.
 *
 * @returns {Promise<boolean>} false when the claim was lost and nothing was written.
 */
async function finishProcessing(id, userId, updates) {
    await initDB();
    const owned = await getOne(
        `SELECT id FROM transcriptions WHERE id = $1 AND user_id = $2 AND status = 'processing'`,
        [id, userId]
    );
    if (!owned) return false;
    await updateTranscription(id, userId, updates);
    return true;
}

/**
 * De gewone toewijzingen van een notitie: één waarde in, één kolom uit, één
 * parameter. Een factory en geen constante, omdat de inhoudskolommen door de
 * envelop gaan en die sleutel aan de rij en haar organisatie hangt.
 */
function plainColumns(id, cryptoCtx) {
    /** Seal one content column's value on its way into `params`. */
    const seal = (column, value) => transcriptCrypto.encryptRow(id, { [column]: value }, cryptoCtx)[column];
    return {
        title: 'title',
        tags: { col: 'tags', transform: v => JSON.stringify(toArray(v)) },
        summary: { col: 'summary', transform: v => seal('summary', v) },
        // The stored preview is derived from this column and has to move with
        // it, or the list keeps showing the previous summary indefinitely.
        summarySnippet: { col: 'summary_snippet_enc', transform: v => transcriptCrypto.buildSummarySnippet(id, v || '', cryptoCtx) },
        speakers: { col: 'speakers', transform: v => seal('speakers', JSON.stringify(toArray(v))) },
        segments: { col: 'segments', transform: v => seal('segments', JSON.stringify(toArray(v))) },
        speakerCount: { col: 'speaker_count', transform: v => new Set((v || []).map(s => s.speaker || s.speakerId)).size },
        segmentCount: { col: 'segment_count', transform: v => (v || []).length },
        transcript: { col: 'transcript', transform: v => seal('transcript', v) },
        chapters: { col: 'chapters', transform: v => seal('chapters', JSON.stringify(toArray(v))) },
        attendees: { col: 'attendees', transform: v => seal('attendees', JSON.stringify(toArray(v))) },
        // Fields the async upload pipeline fills in when a 'processing' note completes.
        status: 'status',
        fullText: { col: 'full_text', transform: v => seal('full_text', v) },
        // The stored preview is derived from this column, so it has to move
        // with it. Leaving it behind would show the previous transcript's
        // opening lines against the new one, indefinitely.
        fullTextSnippet: { col: 'full_text_snippet_enc', transform: v => transcriptCrypto.buildSnippet(id, v || '', cryptoCtx) },
        audioPath: 'audio_path',
        // The durable object-storage key. It used to be writable ONLY by the INSERT,
        // so a note created while object storage happened to be unreachable carried
        // a NULL key forever — and on a deployment with no persistent volume (which
        // is ours) that made the recording permanently unrecoverable the moment the
        // pod holding the local copy went away.
        audioStorageKey: { col: 'audio_storage_key', transform: v => v || null },
        durationSeconds: 'duration_seconds',
        provider: 'provider',
        voiceprintMatches: { col: 'voiceprint_matches', transform: v => JSON.stringify(toArray(v)) },
        // De sjabloonstempel. Beide kolommen zijn expliciet OVERSCHRIJFBAAR met
        // null: wie de samenvatting opnieuw laat schrijven met een eenmalige
        // prompt hoort de oude stempel kwijt te raken, want die zou dan over
        // tekst gaan die dat sjabloon nooit gemaakt heeft. Vandaar `|| null` in
        // plaats van "alleen schrijven als er een waarde is".
        summaryTemplateId: { col: 'summary_template_id', transform: v => v || null },
        summaryTemplateVersion: { col: 'summary_template_version', transform: v => (Number.isInteger(v) ? v : null) },
    };
}

async function updateTranscription(id, userId, updates) {
    await initDB();
    // The org owns the key, and the caller does not pass it — so look it up
    // once, here, rather than threading it through every call site. A row that
    // no longer exists resolves to a plaintext context and the UPDATE below
    // matches nothing anyway.
    const owner = await getOne('SELECT organization_id FROM transcriptions WHERE id = $1', [id]);
    const cryptoCtx = await transcriptCrypto.resolveTranscriptCrypto(owner?.organization_id || null);
    // Twee soorten schrijfactie zitten in dit ene statement, en maar één
    // daarvan is een gewone toewijzing. Die gaan door de builder; de
    // VOORWAARDELIJKE schrijfacties verderop — schrijf-als-onveranderd,
    // schrijf-als-leeg, en het samenvoegvenster van de artefactkolommen —
    // bouwen elk hun eigen CASE of subselect óver de opgeslagen waarde, en dat
    // is geen `kolom = waarde` die een kolommenkaart kan beschrijven.
    //
    // Deze tabel zegt WELKE waarde van de caller welke kolom voedt; drie
    // sleutels voeden er meer dan één. `undefined` betekent overal
    // "ongemoeid laten", dus een niet-meegestuurd veld valt vanzelf weg.
    const write = {
        title: updates.title,
        tags: updates.tags,
        summary: updates.summary,
        summarySnippet: updates.summary,
        speakers: updates.speakers,
        segments: updates.segments,
        speakerCount: updates.segments,
        segmentCount: updates.segments,
        transcript: updates.transcript,
        chapters: updates.chapters,
        attendees: updates.attendees,
        status: updates.status,
        fullText: updates.fullText,
        fullTextSnippet: updates.fullText,
        audioPath: updates.audioPath,
        audioStorageKey: updates.audioStorageKey,
        durationSeconds: updates.durationSeconds,
        provider: updates.provider,
        voiceprintMatches: updates.voiceprintMatches,
        summaryTemplateId: updates.summaryTemplateId,
        summaryTemplateVersion: updates.summaryTemplateVersion,
    };
    const built = buildUpdate({
        table: 'transcriptions',
        updates: write,
        columnMap: plainColumns(id, cryptoCtx),
    });

    const params = built ? built.params : [];
    const setClauses = [];
    let idx = params.length + 1;

    // The AI title lands minutes after the note row was created, by which time
    // the user may already have renamed it — the note is visible and editable
    // the whole time it is 'processing'. Same shape as `tagsIfEmpty`: write
    // only while the column still holds the placeholder we put there.
    if (updates.titleIfUnchanged !== undefined) {
        setClauses.push(`title = CASE WHEN title = $${idx + 1} THEN $${idx}::text ELSE title END`);
        params.push(updates.titleIfUnchanged.title, updates.titleIfUnchanged.expected);
        idx += 2;
    }
    // ── Het vertrekpunt van een lopende run (zie artifactColumnSql) ─────
    // Eén parameter voor alle drie de artefactkolommen: hetzelfde moment, uit
    // dezelfde read. Ontbreekt hij, dan schrijven de drie kolommen zoals
    // altijd (mét stempel, zonder venster) — dat is het pad van elke andere
    // schrijver, die geen minuten tussen lezen en schrijven heeft zitten.
    let sincePh = null;
    const writesArtifacts = updates.actionItems !== undefined
        || updates.decisions !== undefined || updates.questions !== undefined;
    if (writesArtifacts && typeof updates.artifactsSince === 'string' && updates.artifactsSince) {
        sincePh = `$${idx++}`;
        params.push(updates.artifactsSince);
    }
    if (updates.actionItems !== undefined) {
        setClauses.push(`action_items = ${artifactColumnSql('action_items', `$${idx++}`, sincePh)}`);
        params.push(JSON.stringify(toArray(updates.actionItems)));
    }
    if (updates.decisions !== undefined) {
        setClauses.push(`decisions = ${artifactColumnSql('decisions', `$${idx++}`, sincePh)}`);
        params.push(JSON.stringify(toArray(updates.decisions)));
    }
    if (updates.questions !== undefined) {
        setClauses.push(`questions = ${artifactColumnSql('questions', `$${idx++}`, sincePh)}`);
        params.push(JSON.stringify(toArray(updates.questions)));
    }
    // Auto-generated topic tags must never clobber tags a user typed: this
    // variant only fills the column while it is still empty.
    if (updates.tagsIfEmpty !== undefined) {
        setClauses.push(`tags = CASE WHEN tags IS NULL OR tags = '[]'::jsonb THEN $${idx++}::jsonb ELSE tags END`);
        params.push(JSON.stringify(toArray(updates.tagsIfEmpty)));
    }
    // Repair variant: fill the key only while it is still missing. Two replicas
    // can both notice the same unstored file and race; whoever lands second must
    // not overwrite a key that is already good. Same shape as `tagsIfEmpty`.
    if (updates.audioStorageKeyIfMissing !== undefined) {
        setClauses.push(`audio_storage_key = CASE WHEN audio_storage_key IS NULL THEN $${idx++}::text ELSE audio_storage_key END`);
        params.push(updates.audioStorageKeyIfMissing);
    }

    if (!built && setClauses.length === 0) return false;
    const setSql = (built ? `${built.sql}, ` : 'UPDATE transcriptions SET ')
        + [...setClauses, 'updated_at = NOW()'].join(', ');
    params.push(id, userId);
    // RETURNING de drie artefactkolommen — alleen als deze schrijfactie er ook
    // een raakt. Wat er LANDT kan dan afwijken van wat de caller stuurde (een
    // rij die tijdens de run ontstond blijft staan), en de caller moet dat aan
    // de client kunnen antwoorden: anders verdwijnt die rij van het scherm
    // terwijl hij veilig in de database staat — voor de persoon die kijkt niet
    // te onderscheiden van verliezen. Een update die de kolommen niet raakt
    // (een audiosleutel-reparatie bijvoorbeeld) sleept ze ook niet mee terug.
    // De retourwaarde blijft falsy als er niets is geschreven, dus
    // `if (!updated) 404` bij de aanroepers verandert niet.
    const { rowCount, rows } = await run(
        `${setSql} WHERE id = $${params.length - 1} AND user_id = $${params.length}`
        + (writesArtifacts ? ` RETURNING action_items, decisions, questions` : ''),
        params
    );
    if (!(rowCount > 0)) return false;
    const written = rows && rows[0];
    return written
        ? {
            ok: true,
            actionItems: parseJsonArray(written.action_items),
            decisions: parseJsonArray(written.decisions),
            questions: parseJsonArray(written.questions),
        }
        : true;
}

/**
 * Reap async-upload notes stuck in 'processing' — e.g. if the server restarted
 * mid-job (the background pipeline is in-process, so it dies with the process).
 * Flips rows processing for longer than `stuckMinutes` to 'failed' so the UI
 * stops spinning and the note can be reprocessed from its saved audio. Mirrors
 * notebookStore.timeoutStuckSources. Called opportunistically from the list route.
 */
async function timeoutStuckTranscriptions({ stuckMinutes = 180 } = {}) {
    await initDB();
    const { rowCount } = await run(
        `UPDATE transcriptions
            SET status = 'failed', updated_at = NOW()
          WHERE status = 'processing'
            AND updated_at < NOW() - ($1::int * INTERVAL '1 minute')`,
        [stuckMinutes]
    );
    return rowCount || 0;
}

/**
 * Toggle publish state and shared groups for a transcription. Owner-only.
 * Mirrors `knowledgeBases.setPublished`.
 */
/**
 * @param {string|null} [orgId] The owner's org, stamped onto the note when it
 *   does not have one yet. Every org-visibility clause in the read ACL is
 *   `organization_id = ANY(orgIds)`, so publishing a note whose
 *   `organization_id` is NULL set `is_published = true` and changed nothing at
 *   all: the UI reported "shared with the organisation" and no colleague could
 *   ever see it. Notes get a NULL org whenever they were made before the user
 *   joined an org, or by a path that had no org context.
 */
async function setPublished(id, ownerId, isPublished, sharedGroups, orgId = null) {
    await initDB();
    const groupsJson = JSON.stringify(Array.isArray(sharedGroups) ? sharedGroups : []);
    const { rowCount } = await run(
        `UPDATE transcriptions
         SET is_published = $3,
             shared_groups = $4,
             -- COALESCE, never overwrite: a note already belonging to an org
             -- must not be moved into the publisher's current one.
             organization_id = COALESCE(organization_id, $5),
             updated_at = NOW()
         WHERE id = $1 AND user_id = $2`,
        [id, ownerId, !!isPublished, groupsJson, orgId]
    );
    return rowCount > 0;
}

async function deleteTranscription(id, userId) {
    await initDB();
    const { rowCount, rows } = await run(
        'DELETE FROM transcriptions WHERE id = $1 AND user_id = $2 RETURNING audio_path, audio_storage_key',
        [id, userId]
    );
    // Best-effort cleanup of the saved audio file — a deleted note must not
    // leave its recording orphaned on disk. Only unlink paths that resolve
    // inside the uploads root; anything else stays untouched.
    const audioPath = rows?.[0]?.audio_path;
    if (rowCount > 0 && audioPath) {
        const resolved = path.resolve(audioPath);
        if (resolved.startsWith(UPLOADS_ROOT + path.sep)) {
            try {
                await fs.promises.unlink(resolved);
            } catch (e) {
                if (e.code !== 'ENOENT') log.warn(`[TranscriptionStore] Could not delete audio for ${id}: ${e.message}`);
            }
        }
    }
    // The DURABLE copy matters more than the local one: audio_path is
    // ephemeral per replica, so on the SaaS the object-storage copy is
    // usually the only one that still exists. Deleting only the local file
    // left every deleted note's recording behind in RustFS/S3 forever —
    // an erasure-request (GDPR Art. 17) hole, not just wasted storage.
    const storageKey = rows?.[0]?.audio_storage_key;
    if (rowCount > 0 && storageKey) {
        try {
            const storageStore = require('./storageStore');
            if (storageStore.isAvailable()) {
                await storageStore.deleteFile(storageKey);
                log.info(`[TranscriptionStore] Deleted durable audio ${storageKey} for ${id}`);
            }
        } catch (e) {
            log.warn(`[TranscriptionStore] Could not delete durable audio for ${id}: ${e.message}`);
        }
    }
    return rowCount > 0;
}

// ── Project membership ───────────────────────────────────

/**
 * File a meeting note into a project (projects/membership.js, kind 'meeting').
 *
 * Owner-only: filing makes the note readable to every member of the project,
 * and that is the owner's call. The route checks the caller's role on the
 * TARGET project; the statement checks the rest with no gap before the write:
 * the caller owns the note, and the project exists in the note's own
 * organisation (an empty organisation matches only an empty one).
 * `updated_at` is left alone on purpose: filing is not an edit, and a
 * knowledge source that follows a meeting tag re-reads notes by it.
 *
 * A note in a project belongs to the project's members, all of them and only
 * them: it cannot also be shared another way. So a note that is already shared
 * (published to the organisation or to groups, or shared with people) is
 * refused with a 409 that says so, rather than quietly widening or replacing
 * who can read it. (The publish route refuses the other direction: a filed
 * note cannot be published.)
 */
async function setTranscriptionProject(id, userId, projectId, callerOrgIds = []) {
    await initDB();
    if (!id || !userId || !projectId) return false;
    const held = await getOne('SELECT is_published, shared_groups, shared_with FROM transcriptions WHERE id = $1 AND user_id = $2', [id, userId]);
    if (held && (held.is_published === true || parseJsonArray(held.shared_groups).length > 0 || parseJsonArray(held.shared_with).length > 0)) {
        throw Object.assign(
            new Error('This meeting note is already shared another way. Make it personal first, then add it to the project: a note in a project is open to the whole project, and to nobody else.'),
            { status: 409, code: 'MEETING_ALREADY_SHARED' },
        );
    }
    const { rowCount } = await run(
        `UPDATE transcriptions t SET project_id = $1
          WHERE t.id = $2 AND t.user_id = $3
            AND EXISTS (SELECT 1 FROM projects p
                         WHERE p.id = $1 AND (COALESCE(p.organization_id, '') = COALESCE(t.organization_id, '')
                            OR (COALESCE(t.organization_id, '') = '' AND p.organization_id = ANY($4::text[]))))`,
        [projectId, id, userId, [...callerOrgIds]]
    );
    return (rowCount || 0) > 0;
}

/**
 * Take a meeting note out of ONE project. With `userId`, only when that person
 * owns it; with null, whoever owns it, which projects/membership.js allows only
 * the owner of that project. Scoped to `projectId` either way.
 */
async function detachTranscriptionFromProject(id, projectId, userId = null) {
    await initDB();
    if (!id || !projectId) return false;
    const { rowCount } = await run(
        `UPDATE transcriptions SET project_id = NULL
          WHERE id = $1 AND project_id = $2 AND ($3::text IS NULL OR user_id = $3)`,
        [id, projectId, userId]
    );
    return (rowCount || 0) > 0;
}

/**
 * The meeting notes filed into a project, as cards: what a list row shows and
 * nothing it does not. No transcript, summary or snippet leaves here: those
 * are the note's content, read through getTranscription when someone opens it.
 */
async function listProjectMeetings(projectId, { limit = 100, offset = 0 } = {}) {
    await initDB();
    if (!projectId) return [];
    const rows = await getAll(
        `SELECT id, title, user_id, project_id, status, duration_seconds, created_at, updated_at,
                COALESCE(jsonb_array_length(CASE WHEN jsonb_typeof(action_items) = 'array' THEN action_items ELSE '[]'::jsonb END), 0)::int AS action_item_count
           FROM transcriptions
          WHERE project_id = $1
          ORDER BY created_at DESC, id
          LIMIT $2 OFFSET $3`,
        [projectId, Math.min(Math.max(Number(limit) || 100, 1), 200), Math.max(Number(offset) || 0, 0)]
    );
    return rows.map(r => ({
        id: r.id,
        title: r.title,
        userId: r.user_id,
        projectId: r.project_id || null,
        status: r.status || 'completed',
        durationSeconds: Number(r.duration_seconds) || 0,
        actionItemCount: Number(r.action_item_count) || 0,
        createdAt: r.created_at ? new Date(r.created_at).toISOString() : null,
        updatedAt: r.updated_at ? new Date(r.updated_at).toISOString() : null,
    }));
}

/**
 * How many meeting notes each of these projects holds, in ONE query. Missing
 * from the map means none; a failed read rejects.
 */
async function countProjectMeetings(projectIds) {
    await initDB();
    const ids = (Array.isArray(projectIds) ? projectIds : []).filter(id => typeof id === 'string' && id);
    if (!ids.length) return new Map();
    const rows = await getAll(
        `SELECT project_id, COUNT(*)::int AS n FROM transcriptions
          WHERE project_id = ANY($1::text[]) GROUP BY project_id`,
        [ids]
    );
    return new Map(rows.map(r => [r.project_id, Number(r.n) || 0]));
}

/** Detach every meeting note from a deleted project; the notes stay their owners'. */
async function clearProjectFromTranscriptions(projectId) {
    await initDB();
    if (!projectId) return 0;
    const { rowCount } = await run('UPDATE transcriptions SET project_id = NULL WHERE project_id = $1', [projectId]);
    return rowCount || 0;
}

/**
 * The most recent earlier note in the same recurring series (same Google Meet
 * code or Talk room), under the caller's normal read ACL — powers the
 * "previously in this series" card. Light shape: no segments/transcript.
 */
async function getSeriesPrevious({ meetMeetingCode = null, talkRoomToken = null, beforeCreatedAt, excludeId, userId, orgIds = [], userGroupIds = [], isSuperAdmin = false }) {
    await initDB();
    if (!meetMeetingCode && !talkRoomToken) return null;

    const params = [];
    const p = (v) => { params.push(v); return `$${params.length}`; };
    const seriesClause = meetMeetingCode
        ? `meet_meeting_code = ${p(meetMeetingCode)}`
        : `talk_room_token = ${p(talkRoomToken)}`;
    const beforeClause = `created_at < ${p(beforeCreatedAt)}`;
    const excludeClause = `id <> ${p(excludeId)}`;

    // Same ACL as getTranscription: owner, legacy share, or org-published.
    let aclClause = 'TRUE';
    if (!isSuperAdmin) {
        const clauses = [`user_id = ${p(userId)}`, `shared_with @> ${p(JSON.stringify([userId]))}::jsonb`];
        if (Array.isArray(orgIds) && orgIds.length > 0) {
            if (Array.isArray(userGroupIds) && userGroupIds.length > 0) {
                clauses.push(`(is_published = true AND organization_id = ANY(${p(orgIds)}::text[]) AND (shared_groups = '[]'::jsonb OR shared_groups ?| ${p(userGroupIds)}::text[]))`);
            } else {
                clauses.push(`(is_published = true AND organization_id = ANY(${p(orgIds)}::text[]) AND shared_groups = '[]'::jsonb)`);
            }
        }
        aclClause = `(${clauses.join(' OR ')})`;
    }

    const r = await getOne(
        `SELECT id, title, created_at, summary, action_items
         FROM transcriptions
         WHERE ${seriesClause} AND status = 'completed' AND ${beforeClause} AND ${excludeClause} AND ${aclClause}
         ORDER BY created_at DESC LIMIT 1`,
        params
    );
    if (!r) return null;
    const actionItems = parseJsonArray(r.action_items);
    return {
        id: r.id,
        title: r.title,
        createdAt: r.created_at ? new Date(r.created_at).toISOString() : null,
        summary: r.summary || '',
        openActionItems: actionItems.filter((a) => a && !a.done),
    };
}

/**
 * Shape a row for a LIST payload.
 *
 * The list never selects `full_text`, so nothing large is decrypted here: only
 * the stored preview and the summary, both small. `ctx` decides how to open
 * them, never whether they are open — a plaintext row and an encrypted one
 * shape identically.
 */
function mapRow(r, ctx = transcriptCrypto.PLAINTEXT_CONTEXT) {
    // Present only on list payloads, where the query aliases the whole summary
    // column. On a detail payload the summary already came through shapeRow.
    const summarySnippet = r.summary_snippet !== undefined
        ? transcriptCrypto.readSummarySnippet(r, ctx)
        : undefined;
    return {
        id: r.id,
        title: r.title,
        fileName: r.file_name,
        language: r.language,
        durationSeconds: r.duration_seconds,
        speakerCount: r.speaker_count,
        segmentCount: r.segment_count,
        status: r.status || 'completed',
        provider: r.provider || 'voxtral',
        source: r.source || 'upload',
        talkRoomToken: r.talk_room_token || null,
        meetMeetingCode: r.meet_meeting_code || null,
        isPublished: !!r.is_published,
        sharedGroups: parseJsonArray(r.shared_groups),
        // Tags travel on list payloads too — the library filter chips and
        // auto-generated topic tags render straight from the list query.
        ...(r.tags !== undefined ? { tags: parseJsonArray(r.tags) } : {}),
        organizationId: r.organization_id || null,
        // The project this note is filed into, where the query selected it.
        ...(r.project_id !== undefined ? { projectId: r.project_id || null } : {}),
        createdAt: r.created_at ? new Date(r.created_at).toISOString() : null,
        updatedAt: r.updated_at ? new Date(r.updated_at).toISOString() : null,
        // Short transcript prefix surfaced for client-side search; only present
        // on list payloads (full text comes through getTranscription).
        ...(r.full_text_snippet !== undefined
            ? { transcriptSnippet: transcriptCrypto.readSnippet(r, ctx) }
            : {}),
        // Likewise a prefix of the generated summary, so a list row can say
        // what the meeting was ABOUT without shipping the whole summary of
        // every recording. Used by the sidebar's recently-edited panel.
        ...(summarySnippet !== undefined ? { summarySnippet } : {}),
        // List-only aggregates (LIST_AGGREGATES): action counts for the rail's
        // meta line, and the failure reason under its own name. Absent on
        // payloads that did not select them, never 0-by-default.
        ...(r.actions_total !== undefined ? { actionsTotal: Number(r.actions_total) || 0 } : {}),
        ...(r.actions_open !== undefined ? { actionsOpen: Number(r.actions_open) || 0 } : {}),
        // Derived here rather than in SQL: the reason lives in `summary`, and
        // LEFT() over an envelope is not something a person can read.
        ...(summarySnippet !== undefined
            ? { failureReason: r.status === 'failed' ? (summarySnippet || null) : null }
            : {}),
    };
}

module.exports = {
    createTranscription,
    getTranscriptions,
    getTranscription,
    listByTag,
    canReadTranscription,
    getTranscriptionsByAudioPaths,
    getTranscriptionBySourceUri,
    getTranscriptionByTalkRoomToken,
    getTranscriptionByMeetMeetingCode,
    getSeriesPrevious,
    updateTranscription,
    claimForProcessing,
    finishProcessing,
    timeoutStuckTranscriptions,
    setPublished,
    deleteTranscription,
    setTranscriptionProject,
    detachTranscriptionFromProject,
    listProjectMeetings,
    countProjectMeetings,
    clearProjectFromTranscriptions,
};

// Awaitbare init-ingang voor migrateDb (memoised — zelfde promise als de load-time init).
module.exports.initDB = initDB;
