/**
 * De boot-migratieladder — ÉÉN lijst, twee aanroepers.
 *
 * Tot deze extractie leefden deze migraties als losse setImmediate-blokken in
 * startupTasks.js. Dat had twee gevolgen die allebei in productie zijn
 * waargenomen:
 *
 *   1. `npm run db:migrate` draaide ze NIET (migrateDb requiret alleen de
 *      store-modules), dus de gedocumenteerde upgradestap liet precies deze
 *      categorie liggen — datamigraties en vertaalcatalogi.
 *   2. Een catalogus die niet in de lijst stond, draaide nergens en niemand
 *      zag het: geen fout, geen rode test, alleen een stil Engels scherm.
 *      Elf van de vijfentwintig add-nl-catalogi stonden zo op de plank.
 *
 * Daarom staan de lijsten hier, met één regel uitleg per entry, en draaien
 * boot (startupTasks) en migratierunner (migrateDb) exact dezelfde functie.
 * De registratietest op deze lijsten staat in bootMigrations.test.js: een
 * migratiebestand dat nergens geregistreerd of expliciet handmatig is, wordt
 * een rode test in plaats van een vergeten bestand.
 *
 * LEDGER: `schema_migrations` (name, applied_at, checksum) registreert elke
 * entry die geslaagd is; een geregistreerde entry met dezelfde checksum van
 * zijn bestand wordt overgeslagen, een gewijzigd bestand draait opnieuw, en
 * `--force` draait alles. Alles hier blijft idempotent: een bestaande
 * installatie draait de ladder bij de eerste boot met ledger nog één keer
 * volledig en registreert hem dan, en twee replica's die tegelijk booten
 * kunnen dezelfde entry beide draaien. De NL-catalogi draaien bewust NA
 * elkaar — read-modify-write van dezelfde 'nl'-rij (zie add-nl-cowork).
 */

'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');

/**
 * Losse datamigraties (server/migrations/<naam>.js met een up()).
 * Elk idempotent; de reden staat erbij zodat niemand ze "opruimt".
 */
const LOOSE_MIGRATIONS = [
    // Vouwt subscription_plans.allowed_mcp_servers in allowed_integrations en
    // verhuist legacy mcp:<id>-grants; no-op zodra beide leeg zijn.
    'mcp-as-integration-2026-06',
    // Compliance-Hub-als-vlag grandfather: append compliance_hub_gdpr aan
    // bestaande pro/enterprise-plannen zodat geen klant de hub verliest.
    'compliance-plan-flag-2026-09',
    // Verhuist kale prompt-taken naar Cowork; beide runners tikken elke 60s,
    // dus de twee tabellen mogen niet tegelijk levend blijven.
    'prompt-tasks-to-cowork-2026-08',
    // De agent-gekoppelde taken (de oude "agent routines") volgen: Cowork kan
    // een item nu als agent draaien, dus ai_tasks wordt niet meer beschreven.
    'agent-tasks-to-cowork-2026-10',
    // Het opgeslagen woord "routine" wordt "automation" (logs, grants,
    // kennisbank-herkomst, playbooks, tool-sleutel). Na de vorige: een oude
    // ai_tasks-rij herkent hij aan zijn Cowork-twin en labelt hem "cowork".
    'routine-to-automation-2026-10',
    // Learning Center-voortgang volgt de lessen die van "routine" naar
    // "automation" hernoemd zijn (lesson-, oefening-, cursus- en badge-ids).
    'learning-routine-ids-2026-10',
    // Websitepagina's: het demo-blok en /demo-links van "routines" naar "automations".
    'cms-routine-demo-2026-10',
    // Ruimt het schema van de vier gepensioneerde verticals op; laat het
    // consent-ledger staan.
    'drop-retired-features-2026-08',
    // Repareert org-oprichters die op pending/waitlist bleven hangen.
    'fix-org-admin-approval-status',
    // Zorgt dat er precies één default org-plan bestaat (BFSF-226).
    'default-org-plan-2026-06',
    // Backfillt support_audit_log uit legacy support_thread_events.
    'support-audit-log-backfill-2026-06',
    // BFSF-286: organizations.registration_source toevoegen + backfillen.
    'org-registration-source-2026-07',
    // Seedt org_health_problems voor al-kapotte NC-orgs (ON CONFLICT DO NOTHING).
    'org-health-seed-2026-07',
    // ── U10-grandfathers: bestaande orgs behouden exact wat ze vandaag kunnen ──
    // Groeit USER_FACING_CORE, dan grant deze elk nieuw id eenmalig (config-
    // marker begrenst) aan alle bestaande orgs; vandaag een bewuste no-op.
    'org-granted-capabilities-2026-09',
    // Stempelt org_mfa_required_<orgId> expliciet 'uit' voor bestaande orgs
    // (A3-leeskant; ON CONFLICT DO NOTHING laat een gezette vlag met rust).
    'org-mfa-required-2026-09',
    // Stempelt org_cowork_shield_<orgId> expliciet 'uit' voor bestaande orgs
    // (CW-10-schildvlag; het runpad consumeert hem pas in een latere stage).
    'cowork-shield-flag-2026-09',
    // FRM-08: 'ingevuld door' hoort op een rij die blijft — kolom op
    // automation_runs (90d-retentie), níét op de 8-uurs automation_form_sessions.
    'automation-form-submitter-2026-09',
    // W2: webpages.published_version_id + webpage_versions.source, plus een
    // snapshot+pointer voor elke AL gepubliceerde pagina. Zonder deze backfill
    // valt het leespad voor die pagina's terug op de LIVE rij — org-lezers
    // zien dan werk dat de eigenaar nooit publiceerde.
    'webpage-published-version-2026-09',
    // Memory-overhaul 2026-08: corrigeert twee verouderde regels in de GESEEDE
    // extractor-prompt (system-memory-extractor staat op alwaysUpdate: false,
    // dus het .md-bestand bereikt een bestaande install nooit). Gerichte
    // regelvervanging, operator-edits blijven staan; no-op zodra actueel.
    'memory-extractor-prompt-2026-08',
    // Memory-overhaul 2026-08: wist memories die onder een guest_<random>-id
    // zijn geschreven (geen betrokkene achter dat id, dus geen inzage of
    // wissing mogelijk). Eerst memory_sources, dan user_memories; 0 rijen na
    // de eerste run. Slaat over zolang de tabel nog niet bestaat.
    'memory-guest-purge-2026-08',
    // BFSF-387: appends "reply language is not a preference" to the seeded
    // extractor prompt (alwaysUpdate: false, so the .md never reaches an
    // existing install). Append-only, operator edits stay; no-op once present.
    'memory-extractor-language-2026-10',
    // BFSF-272 follow-up: merges case-insensitive duplicate agent categories
    // into the oldest row per (org, LOWER(name)), re-points their agents with
    // a rev bump, and builds idx_agent_categories_org_lname in the same
    // transaction. Throws on failure so the ledger does not record it and the
    // next boot retries; a no-op once the index exists.
    'agent-categories-dedupe-2026-09',
    // Workspace / Solution split: classifies pre-split projects (kind NULL)
    // only where the data is unambiguous; the rest stays NULL (listed on both
    // sides) for the owner to classify. Only touches kind IS NULL, so it is a
    // no-op once every row is decided; throws on failure so the next boot
    // retries.
    'project-kind-backfill-2026-09',
    'project-org-backfill-2026-09',       // Org-less projects get their owner's organisation (group-derived members made them '')
    // "Find repeating work" becomes per user: org-scoped feedback rows are
    // rewritten to user:<id> (built/asked survive), their suggestion_json is
    // cut to the template-only allow-list, and org-scoped scans are deleted
    // (they served one person's mail-derived scan to colleagues). Skips a
    // table that does not exist yet; a no-op once no org: rows are left.
    'suggestion-user-scope-2026-10',
];

/**
 * Nederlandse vertaalcatalogi. Elke entry exporteert up() dat de 'nl'-blob
 * leest, alleen ontbrekende sleutels merget en terugschrijft. SEQUENTIEEL
 * draaien is een harde eis (read-modify-write van dezelfde rij).
 */
const NL_TRANSLATIONS = [
    'add-nl-signup-mfa-reset-auth-translations',
    'add-nl-signup-welcome-neutral-translation',
    'add-nl-login-email-relabel',
    'add-nl-org-registration-source',
    'add-nl-voiceprint-translations',
    'add-nl-approvals-translations',
    'add-nl-solution-membership-translations',
    'add-nl-personal-privacy-shield-translations',
    'add-nl-routines-nodes-translations',
    'add-nl-datatables-translations',
    'add-nl-datatables-nextcloud-translations',
    'add-nl-datatables-spreadsheets-translations',
    'add-nl-forms-answers-translations',
    'add-nl-cowork-translations',
    'add-nl-studio-fundament-translations',
    'add-nl-dlp-review-translations',
    // ── De elf van de plank (U6) ────────────────────────────────────────────
    // Catalogi die vóór deze ladder nergens draaiden: zes bestonden alleen als
    // handmatig script (draaiden bij require en riepen process.exit — in U6
    // omgebouwd naar up()-exports), vier exporteerden al netjes maar stonden
    // in geen enkele lijst, en builder-redesign was nieuw. Volgorde is hier
    // verder betekenisloos: elke catalogus vult alleen ontbrekende sleutels.
    'add-nl-usage-sharing-translations',   // AI-verbruik delen + monitoring-breakdowns
    'add-nl-plan-change-translations',     // Stripe-planwissel + agent-planlimiet
    'add-nl-subscription-translations',    // License & Usage: abonnementskaart, kostenplafond
    'add-nl-settings-translations',        // instellingen, integraties, agent-store, organisatie
    'add-nl-projects-collab-translations', // projecten: gedeelde gesprekken + live feed
    'add-nl-privacy-largescan-translations', // grote-upload PII-scan (fail_open zichtbaar houden)
    'add-nl-connections-translations',     // Settings → Verbindingen + Nextcloud/MCP-kaarten
    'add-nl-gmeet-integrations-translations', // Google Meet-import bij Meeting Notes
    'add-nl-bfsf-sweep-translations',      // geconsolideerde BFSF-bugsweep-strings (2026-07)
    'add-nl-vplan-translations',           // vPlan-integratiekaart
    'add-nl-scaleway-billing-translations', // Scaleway Billing integration card
    'add-nl-builder-redesign-translations', // builder-canvas, stappenlade, mismatch-vragen (Track R)
    'add-nl-builder-values-translations',  // de waarde-editor: lijstkeuze, slotchrome, invoegen (Track R)
    'add-nl-builder-mapping-translations', // geneste data: per item binnen een lijst, AI-koppelen, lege koppelingen in een run
    'add-nl-solution-install-wizard-translations', // de installatiewizard: inhoud, koppelen, toegang (Track O)
    'add-nl-solution-overview-translations', // het Solutions-overzicht: tabs, kaarten, wat niet gelezen kon worden (Track O)
    'add-nl-solution-overview-2-translations', // het Solutions-overzicht, vervolg: zoeken en filteren, lege staat, skills en sjablonen tellen
    'add-nl-topic-rules-translations',     // "is about"-regels in de Condition-node (onderwerp-classifier)
    'add-nl-app-studio-builder-translations', // de App Studio-bouwfilm: activiteitsrijen, bouwbanner, ghost-cel, chatkolom
    'add-nl-playbooks-translations',           // Studio → Playbooks: gefaseerde AI-bouw met pauzes voor akkoord
    'add-nl-compliance-center-translations',  // Compliance Center-redesign: rail, headers, registers, kaders, ladder, checks (data-gedreven)
    'add-nl-learning-center-translations',     // Learning Center-redesign: rail, curriculumkaart, cursustabel, Behaald, spelerchrome
    'add-nl-privacy-shield-redesign-translations', // Privacy Shield-redesign ronde 2: pijplijnstrip, categorie-matrix, de twee checks naast elkaar, What happened als kruisfilter
    'add-nl-privacy-shield-v3-translations',   // Privacy Shield ronde 3: kop met detectiestatus en PATH-strip, Overview-reviewkaart, één matrix, stroomkaart van de twee checks, What happened als één log
    'add-nl-memory-switch-translations',       // Instellingen → Geheugen: de hoofdschakelaar, de statistiekstatus en de zeven typelabels
    'add-nl-chat-activity-translations',       // Chat: de activiteitskaart boven een antwoord (de bouwers-tijdlijn in de gewone chat)
    'add-nl-app-archive-import-translations',  // App Studio "Nieuwe app": het importpaneel voor een sjabloon- of app-archiefbestand, plus Exporteren
    'add-nl-invite-redeem-translations',       // Loginscherm: de twee foutbanners van een verlopen of mislukte uitnodigingslink
    'add-nl-memory-clear-translations',        // Geheugenpaneel: "Clear All" zegt of het je persoonlijke geheugen of dat van het project wist
    'add-nl-security-key-translations',        // Security keys (YubiKey / FIDO2): the Settings → Security card and the sign-in option
    'add-nl-egress-map-translations',          // Privacy Shield "Where your data went": the rebuilt map, its tooltip, legend and controls
    'add-nl-mfa-setup-mobile-translations',    // Forced 2FA setup on a phone: what 2FA is, tap-to-add, a required_desc without "your administrator"
    'add-nl-builder-handoff5-translations',    // Automation builder, design handoff 5: header, ribbon, Settings, Runs, Versions, step drawer, agents in an AI step
    'add-nl-repeating-work-translations',      // Find repeating work: source tiles, the scan as a flow, pattern cards, feedback and undo, the launcher's tabs
    'add-nl-code-step-translations',           // Code step: parameters form, automatic checks, large editor with the AI assistant and Try it
    'add-nl-project-workspace-translations',   // Collaborative project workspace: projects list, overview, members, activity, team and AI chats, content tabs, sidebar project chat, Solution access
    'add-nl-collaboration-wave2-editor-versions-translations',     // Collaboration round 2: editing together, versions and compare, comments, since your last visit, AI that joins by itself, notebooks
    'add-nl-collaboration-wave2-documents-compliance-translations', // Collaboration round 2: documents library, pages, designed documents and presentations, compliance checks for projects
    'add-nl-agent-schedules-translations',     // Agent builder: the schedules panel (Cowork items that run as this agent, formerly scheduled agent runs)
    'add-nl-project-tasks-translations',       // Project tasks: list and board, priority, labels, checklist, tasks from a meeting, comments; team chat threads and tagged items
    'add-nl-learning-foundations-translations', // Leerstof van de Bee Flow Basis-cursus (BFSF-474): lessen, quizzen, sims, de introtour en de actiechecklijsten
    'add-nl-notebooks-as-documents-translations', // A notebook as a document type: in the Documents library, and the notebook workspace's header and sources rail
    'add-nl-spreadsheet-documents-translations', // Spreadsheets in Documents: the type in the library and gallery, the grid editor and its formula errors
    'add-nl-condition-node-translations', // Condition node: rule rows, File type, outputs and Otherwise, Suggest outputs, follow-the-route and whole-list notices, Filter a list
    'add-nl-flatten-node-translations', // Flatten a list: the step card, Simple editor sentences, Choose fields, More options, run sentences
    // Last, after every catalogue: stored translations follow the routine →
    // automation keys, and shipped Dutch "routine" becomes "automatisering".
    'rename-routine-i18n-2026-10',
];

/**
 * Migraties die BEWUST niet bij boot draaien. Ze bestaan, zijn geen vergeten
 * bestanden, en horen in geen van de twee lijsten hierboven: een operator
 * draait ze met de hand (`node server/migrations/<naam>.js`), na de dry-run
 * die hun eigen header voorschrijft. De registratietest
 * (boot/bootMigrations.test.js) gebruikt deze lijst om "handmatig" van
 * "kwijtgeraakt" te onderscheiden.
 */
const MANUAL_MIGRATIONS = [
    // Herschrijft KB-brongrants over bestaande kennisbanken; wil een dry-run
    // en een blik op de uitkomst voordat hij op productiedata losgaat.
    'kb-sources-backfill',
    // Publiceert KB's die aan org-agents hangen — een zichtbaarheidsverbreding
    // die je niet stilzwijgend bij elke boot wilt herhalen.
    'publish-kbs-linked-to-org-agents',
    // Eénmalige backfill van agents.published_config; stores/agent/initSchema.js
    // zegt er expliciet bij dat hij NIET bij boot draait.
    'agents-published-config',
];

const LEDGER_TABLE = 'schema_migrations';

function checksumOf(name) {
    const file = require.resolve(`../migrations/${name}`);
    return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/** name → {checksum, applied_at} for every recorded entry; creates the table on first use. */
async function readLedger() {
    const db = require('../db');
    await db.exec(`CREATE TABLE IF NOT EXISTS ${LEDGER_TABLE} (
        name TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        checksum TEXT NOT NULL
    )`);
    const rows = await db.getAll(`SELECT name, checksum, applied_at FROM ${LEDGER_TABLE}`);
    return new Map(rows.map((r) => [r.name, r]));
}

async function record(name, checksum) {
    await require('../db').run(
        `INSERT INTO ${LEDGER_TABLE} (name, checksum, applied_at) VALUES ($1, $2, now())
         ON CONFLICT (name) DO UPDATE SET checksum = EXCLUDED.checksum, applied_at = now()`,
        [name, checksum]);
}

/**
 * Draai een lijst migraties op volgorde en registreer elke geslaagde in de
 * ledger. Elke fout wordt gevangen en verzameld — één kapotte catalogus mag
 * de rest niet tegenhouden — maar hij is NIET stil: de aanroeper krijgt de
 * failures terug en beslist zelf of dat een warn (boot) of een exit 1
 * (migratierunner) is.
 *
 * @returns {Promise<{ok: string[], skipped: string[], failed: {name: string, error: string}[]}>}
 */
async function runList(names, { log = require('../telemetry/log'), force = false } = {}) {
    const out = { ok: [], skipped: [], failed: [] };
    let ledger = new Map();
    try {
        ledger = await readLedger();
    } catch (e) {
        // No ledger means the pre-ledger behaviour: run everything, record nothing.
        log.warn(`[BootMigrations] ledger onbereikbaar, volledige ladder draait: ${e.message}`);
    }
    for (const name of names) {
        try {
            const checksum = checksumOf(name);
            const prior = ledger.get(name);
            if (prior && !force && prior.checksum === checksum) {
                out.skipped.push(name);
                continue;
            }
            if (prior && prior.checksum !== checksum) {
                log.log(`[BootMigrations] ${name} is gewijzigd sinds ${prior.applied_at} en draait opnieuw`);
            }
            await require(`../migrations/${name}`).up();
            out.ok.push(name);
            try {
                await record(name, checksum);
            } catch (e) {
                log.warn(`[BootMigrations] ${name} geslaagd maar niet geregistreerd (draait volgende keer opnieuw): ${e.message}`);
            }
        } catch (e) {
            out.failed.push({ name, error: e.message });
            log.warn(`[BootMigrations] ${name} faalde: ${e.message}`);
        }
    }
    return out;
}

async function runLooseMigrations(opts) {
    return runList(LOOSE_MIGRATIONS, opts);
}

async function runNlTranslations(opts) {
    return runList(NL_TRANSLATIONS, opts);
}

module.exports = { LOOSE_MIGRATIONS, NL_TRANSLATIONS, MANUAL_MIGRATIONS, LEDGER_TABLE, runLooseMigrations, runNlTranslations };
