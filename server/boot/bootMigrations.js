// @typecheck strict
/**
 * The boot migration ladder — ONE list, two callers.
 *
 * Until this extraction these migrations lived as loose setImmediate blocks in
 * startupTasks.js. That had two consequences that were both observed in
 * production:
 *
 *   1. `npm run db:migrate` did NOT run them (migrateDb requires only the store
 *      modules), so the documented upgrade step left exactly this category
 *      behind — data migrations and translation catalogues.
 *   2. A catalogue that was not in the list ran nowhere and nobody noticed:
 *      no error, no red test, just a silently English screen. Eleven of the
 *      twenty-five add-nl catalogues sat on the shelf that way.
 *
 * That is why the lists live here, with one line of explanation per entry,
 * and boot (startupTasks) and the migration runner (migrateDb) run exactly
 * the same function. The registration test on these lists lives in
 * bootMigrations.test.js: a migration file that is registered nowhere or
 * explicitly manual becomes a red test instead of a forgotten file.
 *
 * LEDGER: `schema_migrations` (name, applied_at, checksum) records every entry
 * that succeeded; a registered entry with the same checksum of its file is
 * skipped, a changed file runs again, and `--force` runs everything. Everything
 * here stays idempotent: an existing installation runs the ladder fully once
 * on the first boot with ledger and then records it; two replicas booting at
 * the same time may both run the same entry. The NL catalogues deliberately
 * run AFTER one another — read-modify-write of the same 'nl' row (see
 * add-nl-cowork).
 *
 * The same table is the ledger of the store schemas: one row per store init,
 * named `store:<tag>`, with the keys of the schema statements it applied
 * (stores/lib/ddlLedger.js). stores/lib/ddlLedgerTable.js owns the table's
 * DDL; readLedger below asks it for the table instead of creating its own.
 */

'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');

/**
 * Loose data migrations (server/migrations/<name>.js with an up()).
 * Each idempotent; the reason is stated so that nobody "cleans them up".
 */
const LOOSE_MIGRATIONS = [
    'microsoft-sso-hardening-2026-10',
    // Vouwt subscription_plans.allowed_mcp_servers in allowed_integrations en
    // verhuist legacy mcp:<id>-grants; no-op zodra beide leeg zijn.
    'mcp-as-integration-2026-06',
    // Compliance Hub as flag grandfather: append compliance_hub_gdpr to
    // existing pro/enterprise plans so that no customer loses the hub.
    'compliance-plan-flag-2026-09',
    // Moves bare prompt tasks to Cowork; both runners tick every 60s,
    // so the two tables must not stay alive at the same time.
    'prompt-tasks-to-cowork-2026-08',
    // The agent-linked tasks (the old "agent routines") follow: Cowork can now
    // run an item as an agent, so ai_tasks is no longer written to.
    'agent-tasks-to-cowork-2026-10',
    // The stored word "routine" becomes "automation" (logs, grants,
    // knowledge-base provenance, playbooks, tool key). After the previous one: an old
    // ai_tasks row is recognised by its Cowork twin and labelled "cowork".
    'routine-to-automation-2026-10',
    // Learning Center progress follows the lessons that were renamed from "routine" to
    // "automation" (lesson, exercise, course and badge ids).
    'learning-routine-ids-2026-10',
    // Website pages: the demo block and /demo links from "routines" to "automations".
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
    // ── U10 grandfathers: existing orgs keep exactly what they can do today ──
    // If USER_FACING_CORE grows, this grants each new id once (config
    // marker bounds it) to all existing orgs; today a deliberate no-op.
    'org-granted-capabilities-2026-09',
    // Stempelt org_mfa_required_<orgId> expliciet 'uit' voor bestaande orgs
    // (A3-leeskant; ON CONFLICT DO NOTHING laat een gezette vlag met rust).
    'org-mfa-required-2026-09',
    // Explicitly stamps org_cowork_shield_<orgId> as 'off' for existing orgs
    // (CW-10 shield flag; the run path only consumes it in a later stage).
    'cowork-shield-flag-2026-09',
    // FRM-08: 'ingevuld door' hoort op een rij die blijft — kolom op
    // automation_runs (90d-retentie), níét op de 8-uurs automation_form_sessions.
    'automation-form-submitter-2026-09',
    // W2: webpages.published_version_id + webpage_versions.source, plus a
    // snapshot+pointer for every page that WAS published. Without this backfill
    // the read path falls back for those pages to the LIVE row — org readers
    // then see work that the owner never published.
    'webpage-published-version-2026-09',
    // Memory overhaul 2026-08: corrects two outdated lines in the SEEDED
    // extractor prompt (system-memory-extractor is set to alwaysUpdate: false,
    // so the .md file never reaches an existing install). Targeted line
    // replacement, operator edits stay; no-op once current.
    'memory-extractor-prompt-2026-08',
    // Memory overhaul 2026-08: deletes memories that were written under a
    // guest_<random> id (no data subject behind that id, so no access or erasure is
    // possible). First memory_sources, then user_memories; 0 rows after the
    // first run. Skips while the table does not yet exist.
    'memory-guest-purge-2026-08',
    // Memory control: wist de plaintext kopie van het chatbericht in
    // memory_sources.message_content (werd nergens gelezen). Idempotent.
    'memory-sources-strip-2026-10',
    // Memory: an earlier backfill labelled extractor rows without evidence as
    // user-written; rows with a memory_sources link go back to inferred.
    'memory-origin-repair-2026-10',
    // BFSF-387: appends "reply language is not a preference" to the seeded
    // extractor prompt (alwaysUpdate: false, so the .md never reaches an
    // existing install). Append-only, operator edits stay; no-op once present.
    'memory-extractor-language-2026-10',
    'memory-extractor-sensitivity-2026-10',
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
    // Which agents may call an agent_call automation became a table
    // (automation_agent_bindings). Binds an active agent_call automation to the
    // agents its OWNER already chose per agent (config.tools.automations or a
    // persona hand-off); everything else stays unbound, so nothing gets wider.
    // Runs once: the ledger records it, and a marker table written together with
    // the inserts holds even when the ledger replays it (changed checksum,
    // unreadable ledger, --force), so an owner who unlinks an agent later never
    // gets it back. Throws while a table is missing, so the next boot retries.
    'automation-agent-bindings-backfill-2026-10',
    // The Component Designer was removed: drops "component_designer" from every
    // org's org_granted_capabilities (and from the column DEFAULT) and deletes
    // the system-component-designer agent row. A no-op once neither is there.
    'drop-component-designer-2026-10',
];

/**
 * Dutch translation catalogues. Each entry exports up() that reads the 'nl'
 * blob, merges only missing keys and writes back. RUNNING SEQUENTIALLY is a hard
 * requirement (read-modify-write of the same row).
 */
const NL_TRANSLATIONS = [
    'add-nl-microsoft-identity-translations',
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
    'add-nl-forms-validation-translations',
    'add-nl-cowork-translations',
    'add-nl-studio-fundament-translations',
    'add-nl-dlp-review-translations',
    // ── The eleven from the shelf (U6) ────────────────────────────────────────
    // Catalogues that ran nowhere before this ladder: six existed only as a manual
    // script (ran on require and called process.exit — in U6 rebuilt into
    // up() exports), four already exported cleanly but were on no list at all,
    // and builder-redesign was new. The order here is otherwise meaningless: each
    // catalogue fills only missing keys.
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
    'add-nl-solution-overview-translations', // the Solutions overview: tabs, cards, what could not be read (Track O)
    'add-nl-solution-overview-2-translations', // het Solutions-overzicht, vervolg: zoeken en filteren, lege staat, skills en sjablonen tellen
    'add-nl-topic-rules-translations',     // "is about"-regels in de Condition-node (onderwerp-classifier)
    'add-nl-app-studio-builder-translations', // de App Studio-bouwfilm: activiteitsrijen, bouwbanner, ghost-cel, chatkolom
    'add-nl-playbooks-translations',           // Studio → Playbooks: gefaseerde AI-bouw met pauzes voor akkoord
    'add-nl-compliance-center-translations',  // Compliance Center-redesign: rail, headers, registers, kaders, ladder, checks (data-gedreven)
    'add-nl-chat-monitoring-translations',    // Chat signals: the Compliance Settings card, the notice in the chat and the embed, the three checks
    'add-nl-learning-center-translations',     // Learning Center-redesign: rail, curriculumkaart, cursustabel, Behaald, spelerchrome
    'add-nl-privacy-shield-redesign-translations', // Privacy Shield-redesign ronde 2: pijplijnstrip, categorie-matrix, de twee checks naast elkaar, What happened als kruisfilter
    'add-nl-privacy-shield-v3-translations',   // Privacy Shield ronde 3: kop met detectiestatus en PATH-strip, Overview-reviewkaart, één matrix, stroomkaart van de twee checks, What happened als één log
    'add-nl-memory-switch-translations',       // Instellingen → Geheugen: de hoofdschakelaar, de statistiekstatus en de zeven typelabels
    'add-nl-chat-activity-translations',       // Chat: de activiteitskaart boven een antwoord (de bouwers-tijdlijn in de gewone chat)
    'add-nl-app-archive-import-translations',  // App Studio "New app": the import panel for a template or app archive file, plus Export
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
    'add-nl-project-rail-translations',         // Project rail: switch project (with the current name), recent projects, search in this project
    'add-nl-project-collab-client-translations', // Project collaboration client: invite by name, transfer ownership, archive and restore
    'add-nl-project-tasks-translations',       // Project tasks: list and board, priority, labels, checklist, tasks from a meeting, comments; team chat threads and tagged items
    'add-nl-project-collab-translations',      // Project collaboration: bell texts for mentions, members, owner and task notifications
    'add-nl-project-golf3-translations',        // Project workspace: Undo toasts, unsaved-changes bar of the task dialog, connection status band
    'add-nl-project-golf4-translations',        // Project chat composers: accessible names of the shared composer box
    'add-nl-learning-foundations-translations', // Leerstof van de Bee Flow Basis-cursus (BFSF-474): lessen, quizzen, sims, de introtour en de actiechecklijsten
    'add-nl-notebooks-as-documents-translations', // A notebook as a document type: in the Documents library, and the notebook workspace's header and sources rail
    'add-nl-document-sharing-translations', // Sharing every document type with organisation, users and groups
    'add-nl-document-encryption-translations', // Documents: unlock-encryption prompt and the encryption error sentences
    'add-nl-spreadsheet-documents-translations', // Spreadsheets in Documents: the type in the library and gallery, the grid editor and its formula errors
    'add-nl-condition-node-translations', // Condition node: rule rows, File type, outputs and Otherwise, Suggest outputs, follow-the-route and whole-list notices, Filter a list
    'add-nl-flatten-node-translations', // Flatten a list: the step card, Simple editor sentences, Choose fields, More options, run sentences
    'add-nl-table-nodes-translations', // Read table / Edit table: the node catalog names
    'update-nl-legal-register-2026-10', // Legal register review of 6 Oct 2026: corrected framework, milestone and check Dutch (old shipped text only), new milestones, "Legal status checked" chip and Sources
    'update-nl-compliance-detect-2026-10', // Compliance round 2 detection and legal wording: one-month DSR clock, CRA notification, DORA/Data Act/EAA/PLD/Machinery terms, encryption levels (old shipped text only), two new milestones; after the legal register review, whose Dutch it partly replaces
    'update-nl-compliance-ui-2026-10', // Compliance Center UI round 2: Dutch for the strings the eleven UI packages added, and reworded Dutch where the English changed meaning (old shipped text only)
    'add-nl-hardcoded-admin-2026-10-translations', // Admin screens (subscriptions, organisation, AI configuration, monitoring, languages, SSO): Dutch for strings that used to be hard-coded English
    'add-nl-hardcoded-pages-shell-2026-10-translations', // Dutch for the user-facing text agent-hub used to hard-code in English: pages, shell, chat footer, meetings, renderers
    'add-nl-hardcoded-integrations-agents-2026-10-translations', // Hard-coded English literals converted to keys: integrations, agents, appearance, support, knowledge, setup wizards
    'add-nl-hardcoded-automation-builder-2026-10-translations', // Automation builder: Dutch for the strings that used to be hard-coded English (panels, step editors, trigger filters, pickers, output views)
    'add-nl-hardcoded-website-admin-2026-10-translations', // Website admin (Product Website builder): strings that had no key
    'add-nl-hardcoded-studio-admin-2026-10-translations', // Studio screens (App Studio, Automations, Executions, Solutions, Support): Dutch for literals that now go through t()
    'add-nl-mcp-access-2026-10-translations',     // MCP access: named MCP tokens (Settings → Security) and the organisation's MCP access policy
    'add-nl-ui-complete-2026-10-translations',    // Every UI string without Dutch (2026-10): agent studio, knowledge, skills, meetings, webpages, cowork, admin, chat, ...
    'add-nl-learn-content-2026-10-translations',  // Learning Center lesson content for every course but Foundations (2026-10)
    'add-nl-builder-fixes-2026-10',            // Builder fixes Oct 2026: HTTP query parameters and cURL import, who can call an automation as an agent tool, assistant questions/plans/tables, Studio no-access
    'add-nl-cms-blog-translations',            // Website blog: editor Blog entry, Markdown toolbar, Latest posts block, and the public /nl/blog labels
    'add-nl-cms-redirects-translations',       // Website redirect manager: the Redirects entry and its inspector
    'add-nl-cms-share-image-translations',     // Website design: card style of the generated share image
    'update-nl-memory-2026-10',                // Memory: Dutch for the memory manager, chat controls, org Memory admin page and Settings lines; "Conversation memory" becomes "Context in lange gesprekken" (old shipped text only)
    // Corrects keys an earlier catalogue shipped as English: after every catalogue above, so its Dutch wins.
    'add-nl-fix-english-2026-10-translations',
    // Settings menu clean-up: "Instellingen → Integraties" becomes "Instellingen → Koppelingen",
    // "Organisatie-instellingen → …" the real menu path, and the relabelled rows (old shipped text only).
    // After the memory catalogue, whose "Context in lange gesprekken" it rewords.
    'update-nl-settings-nav-2026-10',
    // Last, after every catalogue: stored translations follow the routine →
    // automation keys, and shipped Dutch "routine" becomes "automatisering".
    'rename-routine-i18n-2026-10',
];

/**
 * Migrations that deliberately do NOT run at boot. They exist, they are not
 * forgotten files, and they belong in neither of the two lists above: an
 * operator runs them by hand (`node server/migrations/<name>.js`), after the
 * dry run that their own header prescribes. The registration test
 * (boot/bootMigrations.test.js) uses this list to tell "manual" apart from
 * "lost".
 */
const MANUAL_MIGRATIONS = [
    // Herschrijft KB-brongrants over bestaande kennisbanken; wil een dry-run
    // en een blik op de uitkomst voordat hij op productiedata losgaat.
    'kb-sources-backfill',
    // Publishes KBs that hang on org agents — a visibility widening that you
    // do not want to silently repeat on every boot.
    'publish-kbs-linked-to-org-agents',
    // Eénmalige backfill van agents.published_config; stores/agent/initSchema.js
    // zegt er expliciet bij dat hij NIET bij boot draait.
    'agents-published-config',
];

const { LEDGER_TABLE, ensureLedgerTable } = require('../stores/lib/ddlLedgerTable');

/**
 * @param {string} name
 */
function checksumOf(name) {
    const file = require.resolve(`../migrations/${name}`);
    return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/** name → {checksum, applied_at} for every recorded entry; creates the table on first use. */
async function readLedger() {
    const db = require('../db');
    // One owner of the ledger table's own DDL: the store schemas record in it
    // too (stores/lib/ddlLedger.js, rows named `store:<tag>`).
    await ensureLedgerTable(typeof db.ledgerQuery === 'function' ? db.ledgerQuery : (sql) => db.exec(sql));
    const rows = await db.getAll(`SELECT name, checksum, applied_at FROM ${LEDGER_TABLE}`);
    return new Map(rows.map((r) => [r.name, r]));
}

/**
 * @param {string} checksum
 * @param {string} name
 */
async function record(name, checksum) {
    await require('../db').run(
        `INSERT INTO ${LEDGER_TABLE} (name, checksum, applied_at) VALUES ($1, $2, now())
         ON CONFLICT (name) DO UPDATE SET checksum = EXCLUDED.checksum, applied_at = now()`,
        [name, checksum]);
}

/**
 * Run a list of migrations in order and record every successful one in the
 * ledger. Every error is caught and collected — one broken catalogue must not hold
 * back the rest — but it is NOT silent: the caller receives the failures and decides
 * itself whether that is a warn (boot) or an exit 1 (migration runner).
 *
 * @returns {Promise<{ok: string[], skipped: string[], failed: {name: string, error: string}[]}>}
 * @param {string[]} names
 * @param {{ log?: Pick<Console, 'warn' | 'log'>, force?: boolean }} [opts] a Console or the telemetry logger
 */
async function runList(names, { log = require('../telemetry/log'), force = false } = {}) {
    /** @type {{ ok: string[], skipped: string[], failed: { name: string, error: string }[] }} */
    const out = { ok: [], skipped: [], failed: [] };
    let ledger = new Map();
    try {
        ledger = await readLedger();
    } catch (e) {
        // No ledger means the pre-ledger behaviour: run everything, record nothing.
        log.warn(`[BootMigrations] ledger onbereikbaar, volledige ladder draait: ${/** @type {Error} */ (e).message}`);
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
                log.warn(`[BootMigrations] ${name} geslaagd maar niet geregistreerd (draait volgende keer opnieuw): ${/** @type {Error} */ (e).message}`);
            }
        } catch (e) {
            out.failed.push({ name, error: /** @type {Error} */ (e).message });
            log.warn(`[BootMigrations] ${name} faalde: ${/** @type {Error} */ (e).message}`);
        }
    }
    return out;
}

/** @param {Parameters<typeof runList>[1]} [opts] */
async function runLooseMigrations(opts) {
    return runList(LOOSE_MIGRATIONS, opts);
}

/** @param {Parameters<typeof runList>[1]} [opts] */
async function runNlTranslations(opts) {
    return runList(NL_TRANSLATIONS, opts);
}

module.exports = { LOOSE_MIGRATIONS, NL_TRANSLATIONS, MANUAL_MIGRATIONS, LEDGER_TABLE, runLooseMigrations, runNlTranslations };
