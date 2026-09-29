/**
 * De tool-catalogus als ÉÉN lijst.
 *
 * ── WAAROM DIT BESTAAT ──────────────────────────────────────────────
 * `TOOL_REGISTRY` beschrijft de apps die hun tools als TOOLS-array-module
 * leveren. Een handvol integraties doet dat niet: `integrationTools.js` duwt
 * hun tools INLINE op de stapel, achter een eigen poort (een docker-probe voor
 * `browse_web`, een adminvlag voor de regex-tools, een entitlement voor de
 * notitieboeken). Die apps stonden daardoor in geen enkele lijst die de
 * agent-toolkiezer leest — en ze stonden óók niet in de index waaruit
 * `core/agentRuntime/toolPolicy.js` afleidt wélke app een toolnaam bezit.
 *
 * Het gevolg was één bevinding, twee helften: de kiezer kon `browse_web` niet
 * TONEN, en de runtime liet hem door als "niemand claimt deze naam" — ook bij
 * een agent die tot één Gmail-actie was versmald.
 *
 * `ALL_TOOL_APPS` is de plek waar die twee lezers dezelfde lijst zien. Wat
 * hier gepind wordt is dus niet "de lijst bevat X", maar dat er ÉÉN lijst is:
 * twee handbijgehouden lijsten is precies de fout die dit moest oplossen.
 *
 * Run: node --test --test-force-exit automation/toolRegistry.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');

const {
    TOOL_REGISTRY, INLINE_TOOL_APPS, ALL_TOOL_APPS, loadTools, appEntryFor,
} = require('./toolRegistry');

const idsOf = (list) => list.map(e => e.app);

test('ALL_TOOL_APPS is de registry PLUS de inline apps — niets minder, niets dubbel', () => {
    assert.ok(Array.isArray(ALL_TOOL_APPS));
    assert.deepStrictEqual(idsOf(ALL_TOOL_APPS), [...idsOf(TOOL_REGISTRY), ...idsOf(INLINE_TOOL_APPS)]);
    assert.strictEqual(new Set(idsOf(ALL_TOOL_APPS)).size, ALL_TOOL_APPS.length,
        'een app-id twee keer betekent dat één van de twee nooit gevonden wordt (first-wins)');
});

test('TOOL_REGISTRY zelf blijft ongemoeid — hij beantwoordt een ANDERE vraag', () => {
    // `getUserPermittedApps` en `appStudio/browseStep.js` snijden hun antwoord
    // op TOOL_REGISTRY. Een inline app daarin schuiven zou hun betekenis
    // veranderen (zie core/integrations/integrationTools.permittedApps.test.js);
    // daarom staat de uitbreiding ernaast en niet erin.
    const registryIds = new Set(idsOf(TOOL_REGISTRY));
    for (const entry of INLINE_TOOL_APPS) {
        assert.ok(!registryIds.has(entry.app), `${entry.app} hoort NIET in TOOL_REGISTRY`);
    }
});

test('browse_web is toe te schrijven aan een app — de helft die de rechtenlaag miste', () => {
    const owner = ALL_TOOL_APPS.find(e => loadTools(e).some(t => t?.function?.name === 'browse_web'));
    assert.ok(owner, 'browse_web moet een app hebben, anders glijdt hij langs elke per-actie-grant');
    assert.strictEqual(owner.app, 'browser-fetch');
    assert.strictEqual(owner.grantsRequireEntry, true);
});

test('elke inline app laadt echt tools, en zegt hoe een "niet beschikbaar" gelezen moet worden', () => {
    assert.ok(INLINE_TOOL_APPS.length > 0);
    for (const entry of INLINE_TOOL_APPS) {
        const tools = loadTools(entry);
        assert.ok(tools.length > 0, `${entry.app}: ${entry.module}.${entry.arrayName} laadt niets`);
        for (const t of tools) {
            assert.strictEqual(typeof t?.function?.name, 'string', `${entry.app}: tool zonder naam`);
        }
        // Zwijgen over een inline app is geen keuze: de kiezer heeft hem nooit
        // getoond, dus niemand kan hem hebben laten staan. Zie toolPolicy.js.
        assert.strictEqual(entry.grantsRequireEntry, true,
            `${entry.app}: een inline app moet expliciet gegund worden`);
        // "Afwezig op deze installatie" is iets anders dan "jij hebt hem niet
        // verbonden". De kiezer moet dat verschil kunnen zeggen — en waar een
        // app achter MEERDERE poorten zit (de browser: docker-probe én
        // org-entitlement; de notebooks: feature-vlag, entitlement én
        // `use_notebooks`) staan ze er allebei, want één ervan noemen is een
        // bewering die de meting niet oplevert.
        const kinds = Array.isArray(entry.availability) ? entry.availability : [entry.availability];
        assert.ok(kinds.length > 0, `${entry.app}: availability moet zeggen WAAROM een app kan ontbreken`);
        for (const kind of kinds) {
            assert.ok(['installation', 'connection', 'permission'].includes(kind),
                `${entry.app}: onbekende availability "${kind}"`);
        }
        assert.strictEqual(new Set(kinds).size, kinds.length, `${entry.app}: dubbele availability`);
    }
});

// ── Twee entries, één set toolnamen (A2-4) ──────────────────────────
// `outlook` en `outlook-readonly` laden dezelfde module: dezelfde namen, op
// dezelfde credentials, waarvan de tweede een strikte subset levert. De
// attributie-index van de rechtenlaag kent een naam aan één app toe, dus de
// andere bezat er nul — en een grant die op die andere was opgeslagen ging
// nergens over, terwijl de kiezer hem gewoon liet opslaan.
//
// De regel is niet "dit mag niet", want de twee smaken bestaan met een reden
// (de org-gate kiest welke wordt aangeboden). De regel is dat het GEDECLAREERD
// moet zijn: `grantsVia` wijst de app aan die de gedeelde namen bezit. De
// rechtenlaag leest dat — eigendom volgt de declaratie in plaats van de
// volgorde van deze lijst, en élke claimende app moet een gedeelde naam
// toestaan (core/agentRuntime/toolPolicy.sharedModule.test.js).
//
// Deze test is de duurzame helft: wie hier een entry bijzet die namen deelt
// zonder dat te declareren, krijgt hem rood terug in plaats van een stille
// dode grant.

/** naam → [app-id, …] over de ECHTE lijst. */
function claimantsByName() {
    const out = new Map();
    for (const entry of ALL_TOOL_APPS) {
        for (const t of loadTools(entry)) {
            const name = t?.function?.name;
            if (typeof name !== 'string' || !name) continue;
            if (!out.has(name)) out.set(name, []);
            const ids = out.get(name);
            if (!ids.includes(entry.app)) ids.push(entry.app);
        }
    }
    return out;
}

const declaredOwnerOf = (appId) => {
    const e = appEntryFor(appId);
    return e && typeof e.grantsVia === 'string' && e.grantsVia ? e.grantsVia : null;
};

test('elke gedeelde toolnaam heeft precies één eigenaar, en de rest DECLAREERT dat', () => {
    const shared = [...claimantsByName()].filter(([, ids]) => ids.length > 1);

    for (const [name, ids] of shared) {
        const owners = ids.filter(id => declaredOwnerOf(id) === null);
        assert.strictEqual(owners.length, 1,
            `"${name}" wordt geleverd door ${ids.join(', ')}. Precies één van die apps mag `
            + 'hem bezitten; de andere moeten `grantsVia: \'<eigenaar>\'` in TOOL_REGISTRY '
            + 'zetten. Zonder die declaratie hangt het eigendom aan de VOLGORDE van deze '
            + 'lijst, en is een grant op de andere app stil dood.');
        for (const id of ids) {
            if (id === owners[0]) continue;
            assert.strictEqual(declaredOwnerOf(id), owners[0],
                `${id} deelt "${name}" met ${owners[0]} en moet daar via grantsVia naar wijzen`);
        }
    }
});

test('grantsVia wijst naar een bestaande app, levert een subset, en ketent niet', () => {
    const claimants = claimantsByName();
    const namesOf = (appId) => loadTools(appEntryFor(appId) || {}).map(t => t?.function?.name).filter(Boolean);

    for (const entry of ALL_TOOL_APPS) {
        const via = declaredOwnerOf(entry.app);
        if (!via) continue;
        assert.notStrictEqual(via, entry.app, `${entry.app}: grantsVia mag niet naar zichzelf wijzen`);
        const owner = appEntryFor(via);
        assert.ok(owner, `${entry.app}: grantsVia wijst naar "${via}", die niet bestaat`);
        assert.strictEqual(declaredOwnerOf(via), null,
            `${entry.app}: grantsVia mag niet ketenen — "${via}" laat zijn grants zelf elders lopen`);

        // Een subset, niet zomaar "verwant": bezit de alias een naam die de
        // eigenaar niet levert, dan bezit hij hem in de praktijk zelf en zegt
        // de declaratie iets onwaars.
        const ownerNames = new Set(namesOf(via));
        for (const name of namesOf(entry.app)) {
            assert.ok(ownerNames.has(name),
                `${entry.app}: levert "${name}", maar ${via} niet — dan is dit geen subset`);
            assert.ok((claimants.get(name) || []).includes(via),
                `${entry.app}: "${name}" wordt niet echt gedeeld met ${via}`);
        }
    }
});

test('outlook-readonly is de bekende gedeelde entry, en is als zodanig gedeclareerd', () => {
    // Geen "de lijst bevat X"-pin: dit is de entry waar de bevinding op zat, en
    // de declaratie is wat hem uit de stille-dode-grant-toestand haalt.
    const ro = appEntryFor('outlook-readonly');
    assert.ok(ro, 'outlook-readonly hoort in het registry te staan');
    assert.strictEqual(ro.grantsVia, 'outlook');
    assert.strictEqual(ro.module, appEntryFor('outlook').module, 'dezelfde module, dezelfde namen');
});

test('appEntryFor vindt inline apps net zo goed als registry-apps', () => {
    assert.strictEqual(appEntryFor('gmail')?.arrayName, 'GMAIL_TOOLS');
    assert.strictEqual(appEntryFor('browser-fetch')?.arrayName, 'BROWSE_WEB_TOOLS');
    assert.strictEqual(appEntryFor('nope'), null);
    assert.strictEqual(appEntryFor(null), null);
});

// ── De anti-drift-pin ───────────────────────────────────────────────
// Bron-assertions en geen require(): toolCatalog.js trekt een express-router
// en de halve store-graaf mee. Wat hier gepind wordt is structureel, dus het
// lezen van de bron is óók het eerlijke antwoord.

test('de KIEZER en de RUNTIME lezen allebei ALL_TOOL_APPS', () => {
    // De attributie-index van de runtime zit sinds de opsplitsing van toolPolicy.js
    // in `toolPolicy/appIndex.js` — dat is het bestand dat ALL_TOOL_APPS moet lezen.
    const policy = fs.readFileSync(require.resolve('../core/agentRuntime/toolPolicy/appIndex'), 'utf8');
    const catalog = fs.readFileSync(require.resolve('../routes/agents/toolCatalog'), 'utf8');

    assert.match(policy, /ALL_TOOL_APPS/,
        'de attributie-index van de runtime moet de gedeelde lijst lezen');
    assert.match(catalog, /ALL_TOOL_APPS/,
        'de tool-catalogus van de kiezer moet dezelfde lijst lezen');

    // En geen van beide mag terugvallen op de smallere lijst: dat is precies
    // hoe browse_web onzichtbaar werd voor allebei.
    const strip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    for (const [name, src] of [['toolPolicy', policy], ['toolCatalog', catalog]]) {
        assert.ok(!/for \(const entry of TOOL_REGISTRY/.test(strip(src)),
            `${name} loopt nog over TOOL_REGISTRY — dan mist hij de inline apps opnieuw`);
    }
});
