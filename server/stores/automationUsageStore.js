// @typecheck
/**
 * `automation_usage` — WIE DRAAIT DEZE AUTOMATISERING? (P4 deel C)
 *
 * De spiegel van `automation_datatable_usage`: die beantwoordt "wie raakt deze
 * TABEL aan", deze beantwoordt "wie drukt op deze AUTOMATION". Vandaag is er één
 * soort gebruiker — een knop in een Studio-app (`consumer_kind = 'app'`) — en
 * de tabel is zo gevormd dat er later een webpagina of een agent bij kan
 * zonder hem te hervormen.
 *
 * ── WAAROM EEN EIGEN TABEL, EN NIET EEN VELD IN DE BESTAANDE INDEX ───
 *
 * `automation_datatable_usage` is per TABEL-DOEL gekeyd, en dat is een FK, geen
 * conventie: `datatable_id TEXT NOT NULL REFERENCES datatables(id) ON DELETE
 * CASCADE`. Drie gevolgen, elk op zich al fataal voor hergebruik:
 *
 *   1. De INSERT is gegrendeld op de datatable-rij (`INSERT … SELECT … FROM
 *      datatables d WHERE d.id = $6`). Zonder rij in `datatables` schrijft hij
 *      NUL rijen en noemt zichzelf geslaagd — de stille poort die deze hele
 *      familie juist moet dichthouden.
 *   2. De scope komt van de TABEL, niet van de gebruiker. Zonder tabel is er
 *      geen scope-bron.
 *   3. De CASCADE hangt aan `datatables`. Een app→automation-rij moet verdwijnen
 *      als de APP of de AUTOMATION weg is — een andere levensduur.
 *
 * Daar komt de deploy-reden bij die in de kop van datatableStore.js staat: die
 * DDL draait bij elke module-load op elke replica onder een rolling deploy met
 * automatische `rollout undo`, dus die tabel wordt niet hervormd. Vandaar deze.
 *
 * ── DE SLEUTEL: (soort, gebruiker, verwijzing, automation) ──────────────
 *
 * `ref_id` is de ACTIE (`act:<actionId>`), niet de stap. Een sequence-stap
 * heeft geen id — `containsStepKind` in appStudio/validate/actions.js loopt hem
 * op POSITIE af — en een positie als halve primaire sleutel is precies wat W5
 * verbiedt: hij schuift bij elke bewerking op, de reconcile schrijft een nieuwe
 * rij en de index groeit tot hij niets meer betekent. Een actie-id is stabiel
 * (validate.js dwingt `act_xxxx` af), dus één rij per (app, actie, automation).
 *
 * `automation_id` zit IN de sleutel omdat één actie twee automatiseringen kan draaien
 * (twee `run_automation`-stappen in dezelfde sequence). Zonder dat zou de
 * tweede de eerste overschrijven en zou één van de twee automatiseringen zichzelf als
 * ongebruikt zien.
 *
 * ── DE INSERT IS GEGRENDELD OP DE EIGENAAR ───────────────────────────
 *
 * Dit is de belangrijkste regel in dit bestand. `INSERT … SELECT … FROM
 * automations a WHERE a.id = $x AND a.user_id = $ownerUserId` — de rij komt er
 * alleen als de automatisering ECHT bestaat en van dezelfde persoon is als de app.
 *
 * Waarom eigendom en niets ruimers: een app draait een automatisering ACTS-AS-OWNER
 * (`appStudio/actionExecutor/automationBridge.js`: "a post-wiring transfer must
 * never let the app run someone else's automation acts-as-owner"), en die brug
 * weigert bij `automation.userId !== app.userId`. Een verwijzing over de
 * eigenaarsgrens heen kán dus niet draaien; hem tóch indexeren zou de eigenaar
 * van de automatisering de NAAM van andermans app tonen ("gebruikt door 1 knop" van
 * iemand die hij niet kent) op grond van een koppeling die bij de eerste klik
 * weigert. Onbekend versmalt, dus: geen rij.
 *
 * En omdat de guard in de INSERT zit en niet bij de aanroeper, is "wie is de
 * eigenaar" één feit uit één rij: `owner_user_id` en `organization_id` worden
 * van de automatisering gelezen, nooit van de aanroeper gekopieerd — dezelfde regel
 * die `reconcileUsageFor` op de datatable-scope toepast.
 *
 * Het gevolg voor de aanroeper: een NIET-lege lijst die NUL rijen schrijft is
 * geen geslaagde reconcile maar een eigendoms- of bestaansprobleem, en de
 * reconciler hoort dat te zeggen (zie automationUsageSync.js).
 *
 * ── ER IS GEEN FK, DUS ER MOET GEPURGED WORDEN ───────────────────────
 *
 * `automations` en `studio_apps` horen bij andere stores; een FK tussen store-
 * schema's die elk hun eigen boot-DDL draaien is precies de volgorde-afhanke-
 * lijkheid die geen van beide kan garanderen. Dus twee purge-paden:
 * `purgeUsageForConsumer` als de APP weg is, `purgeUsageOfAutomation` als de
 * AUTOMATION weg is. Beide worden aangeroepen vanaf het delete-pad; welke
 * bestanden dat zijn staat in appStudio/automationUsage.savePaths.test.js.
 *
 * ── DDL VIA runDdl ───────────────────────────────────────────────────
 *
 * De ladderregel (boot/bootMigrations.test.js): een nieuwe kolom of tabel hoort
 * in de idempotente boot-DDL van zijn eigen store, en dan via `runDdl`
 * (stores/lib/_ddl.js) — niet in een los migratiebestand en niet in een
 * `DO $$ … EXCEPTION WHEN OTHERS THEN NULL`-blok, want dat slikt een
 * statement-timeout net zo hard in als "bestond al". De claim staat als
 * COLUMN_LADDERS-entry in die test.
 */

'use strict';

const { run, getOne, getAll, withTransaction } = require('../db');
const { makeStoreInit } = require('./lib/storeInit');
const { runDdl } = require('./lib/_ddl');

/**
 * Wat een automatisering kan aanzetten. Vandaag alleen een app-knop. Een soort
 * toevoegen betekent zijn reconciler op ELK save-pad van die soort zetten —
 * appStudio/automationUsage.savePaths.test.js houdt die lijst bij.
 */
const CONSUMER_KINDS = Object.freeze(['app']);

function assertConsumerKind(kind, who) {
    if (!CONSUMER_KINDS.includes(kind)) {
        throw new Error(`${who} requires a consumerKind of ${CONSUMER_KINDS.join(' | ')}, got ${JSON.stringify(kind)}`);
    }
    return kind;
}

const initDB = makeStoreInit('AutomationUsageStore', async () => {
    const res = await runDdl('automationUsageStore', [
        `CREATE TABLE IF NOT EXISTS automation_usage (
            automation_id   TEXT NOT NULL,
            consumer_kind   TEXT NOT NULL,
            consumer_id     TEXT NOT NULL,
            ref_id          TEXT NOT NULL,
            owner_user_id   TEXT NOT NULL,
            organization_id TEXT,
            screen_id       TEXT,
            node_id         TEXT,
            label           TEXT,
            wired           BOOLEAN NOT NULL DEFAULT TRUE,
            updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            PRIMARY KEY (consumer_kind, consumer_id, ref_id, automation_id)
        )`,
        // "Wie gebruikt DEZE automation" is de hete vraag (de capsule, en straks
        // de poort voor een verwijdering), dus die krijgt zijn eigen index.
        `CREATE INDEX IF NOT EXISTS idx_automation_usage_automation ON automation_usage(automation_id)`,
        // En de andere kant: alles van één app opruimen of vervangen.
        `CREATE INDEX IF NOT EXISTS idx_automation_usage_consumer ON automation_usage(consumer_kind, consumer_id)`,
        // ── HET DERDE ANTWOORD: "NOG NOOIT GEKEKEN" ──────────────────
        //
        // `automation_usage` kan alleen rijen tonen. Nul rijen betekent daar
        // twee volstrekt verschillende dingen: "geen enkele knop draait deze
        // automation" en "deze index is voor die app nog nooit gebouwd". Op de
        // dag van uitrol is dat tweede waar voor ÉLKE bestaande app — de tabel
        // wordt leeg aangelegd en vult zich alleen als iemand een app opslaat —
        // en dan leest elke automation-eigenaar "No app button runs this automatisering
        // yet" over knoppen die gewoon draaien. Dat is een uitspraak over de
        // wereld, gedaan op een tabel die nog nooit is gevuld.
        //
        // Vandaar deze bijhoudtabel: één rij per gebruiker (vandaag: per app)
        // die ooit is geïndexeerd. Zij maakt "leeg" en "onbekend" scheidbaar,
        // en zij is de werklijst van de backfill.
        `CREATE TABLE IF NOT EXISTS automation_usage_indexed (
            consumer_kind   TEXT NOT NULL,
            consumer_id     TEXT NOT NULL,
            indexed_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            PRIMARY KEY (consumer_kind, consumer_id)
        )`,
    ]);
    // runDdl meldt SQLSTATE-fouten terug in plaats van te gooien. Hier is dat
    // niet genoeg: op een half aangelegd schema geeft élke lees stil een lege
    // lijst terug, en leeg betekent hier "geen enkele knop draait deze
    // automation" — precies de bewering die niemand mag doen zonder tabel.
    if (res.failures.length) {
        throw new Error(`automation_usage DDL faalde (${res.failures.map(f => f.code).join(', ')}) — zie de [DDL:automationUsageStore]-regels`);
    }
});

/**
 * De tabellen die `listUsageOfAutomation` mag LEFT JOINen, één keer gepolst.
 *
 * `studio_apps` hoort bij een store die zijn DDL bij EERSTE GEBRUIK aanlegt, dus
 * op een verse installatie kan hij ontbreken tot iemand App Studio opent — en
 * een JOIN naar een niet-bestaande relatie is een 500 op de capsule. Zelfde
 * `to_regclass`-truc als `datatableStore.consumerJoins`: onthouden zodra hij er
 * is, tot dan één goedkope query per aanroep. Ontbreekt hij, dan komen de rijen
 * terug met een lege titel — nooit met minder rijen.
 */
let _joinable = null;
async function consumerJoins() {
    if (_joinable) return _joinable;
    const r = await getOne(`SELECT (to_regclass('studio_apps') IS NOT NULL) AS apps`);
    const have = { apps: !!r?.apps };
    if (have.apps) _joinable = have;
    return have;
}

function mapRow(r) {
    return {
        automationId: r.automation_id,
        consumerKind: r.consumer_kind,
        consumerId: r.consumer_id,
        consumerTitle: r.app_title || null,
        // De EIGENAAR VAN DE AUTOMATISERING, niet van de app. De kolom heet
        // `owner_user_id` en wordt bij de INSERT van `automations.user_id`
        // gelezen; hij heette hier `consumerOwner`, wat hem las als een
        // app-eigendomscontrole terwijl het een verouderingsfilter op de
        // automation-eigenaar is. Wie de APP mag openen is een andere vraag, en
        // die wordt in de route beantwoord (`canOpen`), niet afgeleid.
        automationOwner: r.owner_user_id || null,
        refId: r.ref_id,
        // `ref_id` is `act:<actionId>`; het scherm leest liever het kale id.
        actionId: typeof r.ref_id === 'string' && r.ref_id.startsWith('act:') ? r.ref_id.slice(4) : null,
        screenId: r.screen_id || null,
        nodeId: r.node_id || null,
        label: r.label || null,
        wired: r.wired !== false,
        organizationId: r.organization_id || null,
        updatedAt: r.updated_at ? new Date(r.updated_at).toISOString() : null,
    };
}

/**
 * Zet de index gelijk aan wat ÉÉN gebruiker (vandaag: één app) nu aan automations
 * noemt. Delete-then-insert op `(consumer_kind, consumer_id)`.
 *
 * DE AANROEPER MOET WETEN: een lege `entries` WIST alles van deze gebruiker.
 * Dat is de bedoeling — een app die zijn laatste knop weghaalt hoort uit de
 * index te verdwijnen — maar het betekent ook dat een MISLUKTE scan hier nooit
 * als lege lijst mag binnenkomen. Die regel hoort bij de reconciler
 * (appStudio/automationUsageSync.js, regel 1), niet hier: deze laag kan het
 * verschil tussen "niets gevonden" en "niet kunnen kijken" niet zien.
 *
 * @param {'app'} consumerKind
 * @param {string} consumerId          de studio_apps-id
 * @param {string} ownerUserId         de EIGENAAR van die app — de INSERT eist
 *   dat de automatisering van dezelfde persoon is; zie de kop.
 * @param {Array<{automationId:string, refId:string, screenId?:string|null,
 *                nodeId?:string|null, label?:string|null, wired?:boolean}>} entries
 * @returns {Promise<number>} rijen die ECHT zijn geschreven — niet hoeveel er
 *   werden aangeboden. Een niet-lege lijst die 0 schrijft betekent: de automatisering
 *   bestaat niet (meer), of hij is van iemand anders.
 */
async function reconcileAutomationUsage(consumerKind, consumerId, ownerUserId, entries) {
    await initDB();
    assertConsumerKind(consumerKind, 'reconcileAutomationUsage');
    if (!consumerId) throw new Error('reconcileAutomationUsage requires a consumerId');
    if (!ownerUserId) throw new Error('reconcileAutomationUsage requires an ownerUserId');
    const rows = (Array.isArray(entries) ? entries : [])
        .filter(e => e && typeof e.automationId === 'string' && e.automationId
            && typeof e.refId === 'string' && e.refId);

    return withTransaction(async (client) => {
        await client.query(
            `DELETE FROM automation_usage WHERE consumer_kind = $1 AND consumer_id = $2`,
            [consumerKind, consumerId],
        );
        let written = 0;
        for (const e of rows) {
            const r = await client.query(
                `INSERT INTO automation_usage
                    (automation_id, consumer_kind, consumer_id, ref_id,
                     owner_user_id, organization_id, screen_id, node_id, label, wired)
                 SELECT a.id, $1, $2, $3, a.user_id, a.organization_id, $4, $5, $6, $7
                   FROM automations a
                  WHERE a.id = $8 AND a.user_id = $9
                 ON CONFLICT (consumer_kind, consumer_id, ref_id, automation_id)
                 DO UPDATE SET owner_user_id = EXCLUDED.owner_user_id,
                               organization_id = EXCLUDED.organization_id,
                               screen_id = EXCLUDED.screen_id,
                               node_id = EXCLUDED.node_id,
                               label = EXCLUDED.label,
                               wired = EXCLUDED.wired,
                               updated_at = NOW()`,
                [consumerKind, consumerId, e.refId,
                    e.screenId || null, e.nodeId || null, e.label || null, e.wired !== false,
                    e.automationId, ownerUserId],
            );
            written += r?.rowCount || 0;
        }
        // In DEZELFDE transactie als de delete-then-insert: "deze app is
        // bekeken" en "dit is wat zij aanzet" zijn hetzelfde feit, en een
        // markering zonder rijen (of andersom) zou precies het onderscheid
        // kapotmaken dat zij moet dragen. Nul geschreven rijen is óók een
        // geldige uitslag — een app die niets aanzet is gewoon geïndexeerd.
        await client.query(
            `INSERT INTO automation_usage_indexed (consumer_kind, consumer_id)
             VALUES ($1, $2)
             ON CONFLICT (consumer_kind, consumer_id) DO UPDATE SET indexed_at = NOW()`,
            [consumerKind, consumerId],
        );
        return written;
    });
}

/**
 * Is de index compleet genoeg dat "geen rijen" iets betekent?
 *
 * Waar: elke app die vandaag bestaat is minstens één keer geïndexeerd. Onwaar:
 * er is er minstens één die nog nooit is bekeken, en dan mag geen enkel scherm
 * "wordt nergens gebruikt" beweren — die knop kan in die app zitten.
 *
 * `studio_apps` hoort bij een store die zijn DDL bij EERSTE GEBRUIK aanlegt,
 * dus op een verse installatie kan de tabel ontbreken. Dan is er ook geen app
 * die ongeïndexeerd kan zijn: `complete: true`, `pending: 0`. Onbekend versmalt
 * hier dus NAAR compleet, en dat is geen uitzondering op de regel maar de regel
 * zelf — zonder apps kan er geen knop zijn die we missen.
 *
 * @returns {Promise<{complete: boolean, pending: number}>}
 */
async function usageIndexCoverage() {
    await initDB();
    const have = await consumerJoins();
    if (!have.apps) return { complete: true, pending: 0 };
    const r = await getOne(
        `SELECT COUNT(*)::int AS pending
           FROM studio_apps a
          WHERE NOT EXISTS (
                SELECT 1 FROM automation_usage_indexed i
                 WHERE i.consumer_kind = 'app' AND i.consumer_id = a.id)`,
    );
    const pending = Number(r?.pending) || 0;
    return { complete: pending === 0, pending };
}

/**
 * De apps die nog nooit zijn geïndexeerd — de werklijst van de backfill.
 * Begrensd, want dit draait naast een verzoek.
 */
async function listUnindexedApps(limit = 50) {
    await initDB();
    const have = await consumerJoins();
    if (!have.apps) return [];
    const rows = await getAll(
        `SELECT a.id
           FROM studio_apps a
          WHERE NOT EXISTS (
                SELECT 1 FROM automation_usage_indexed i
                 WHERE i.consumer_kind = 'app' AND i.consumer_id = a.id)
          ORDER BY a.updated_at DESC NULLS LAST
          LIMIT $1`,
        [Math.max(1, Math.min(Number(limit) || 50, 500))],
    );
    return (rows || []).map(r => r.id);
}

/**
 * Wie draait deze automatisering — de capsule.
 *
 * Alleen rijen van deze automatisering; de titel van de app komt via een LEFT JOIN
 * mee zodat een verdwenen app een naamloze rij oplevert in plaats van een
 * ontbrekende. Sorteren op `updated_at DESC` zodat de laatst aangeraakte knop
 * bovenaan staat, hetzelfde als `datatableStore.listUsage`.
 */
async function listUsageOfAutomation(automationId) {
    await initDB();
    if (!automationId) return [];
    const have = await consumerJoins();
    const rows = await getAll(
        `SELECT u.*${have.apps ? `, s.name AS app_title` : ''}
           FROM automation_usage u
           ${have.apps ? `LEFT JOIN studio_apps s ON u.consumer_kind = 'app' AND s.id = u.consumer_id` : ''}
          WHERE u.automation_id = $1
          ORDER BY u.updated_at DESC`,
        [automationId],
    );
    return (rows || []).map(mapRow);
}

/**
 * Hoeveel knoppen draaien elk van deze automatiseringen — de pil op een lijst, in één
 * GROUP BY in plaats van één lees per rij.
 * @returns {Promise<Map<string, number>>} automation-id → aantal (0 voor een
 *   automatisering die nergens in staat)
 */
async function countUsageOfAutomations(automationIds) {
    await initDB();
    const ids = (Array.isArray(automationIds) ? automationIds : []).filter(Boolean);
    const out = new Map(ids.map(id => [id, 0]));
    if (!ids.length) return out;
    const rows = await getAll(
        `SELECT automation_id, COUNT(*)::int AS refs
           FROM automation_usage
          WHERE automation_id = ANY($1::text[])
          GROUP BY automation_id`,
        [ids],
    );
    for (const r of (rows || [])) out.set(r.automation_id, Number(r.refs) || 0);
    return out;
}

/** De app is weg — haal zijn rijen weg. Er is geen FK die dit doet. */
async function purgeUsageForConsumer(consumerKind, consumerId) {
    await initDB();
    assertConsumerKind(consumerKind, 'purgeUsageForConsumer');
    if (!consumerId) return 0;
    const res = await run(
        `DELETE FROM automation_usage WHERE consumer_kind = $1 AND consumer_id = $2`,
        [consumerKind, consumerId],
    );
    // Ook de markering weg: een app die niet meer bestaat is niet
    // "geïndexeerd", hij is er niet. Bleef de rij staan, dan zou een
    // teruggekeerd id (bij een import met hetzelfde id) als bekeken gelden
    // terwijl er nooit naar gekeken is.
    await run(
        `DELETE FROM automation_usage_indexed WHERE consumer_kind = $1 AND consumer_id = $2`,
        [consumerKind, consumerId],
    );
    return res?.rowCount || 0;
}

/**
 * De AUTOMATION is weg — haal haar rijen weg.
 *
 * De andere kant van dezelfde ontbrekende FK. Zonder dit blijft een rij staan
 * die een app claimt te bedienen die niets meer aanzet, en die rij zou een
 * volgende poort (een 409 op een verwijdering) namens een automatisering tegenhouden
 * die niet meer bestaat.
 */
async function purgeUsageOfAutomation(automationId) {
    await initDB();
    if (!automationId) return 0;
    const res = await run(`DELETE FROM automation_usage WHERE automation_id = $1`, [automationId]);
    return res?.rowCount || 0;
}

module.exports = {
    CONSUMER_KINDS,
    initDB,
    reconcileAutomationUsage,
    listUsageOfAutomation,
    countUsageOfAutomations,
    usageIndexCoverage,
    listUnindexedApps,
    purgeUsageForConsumer,
    purgeUsageOfAutomation,
};
