/**
 * Elk pad dat een app-definitie bewaart, brengt `automation_usage` in stap —
 * GETELD, niet opgesomd.
 *
 * `reconcileAutomationUsage` is delete-then-insert op (consumer_kind,
 * consumer_id). Een schrijfpad dat de reconcile overslaat voegt dus niet
 * gewoon niets toe: het laat de rijen van de VÓRIGE definitie staan. Een actie
 * die haar routine kwijtraakt houdt de capsule "Gebruikt door 1 knop" in de
 * lucht, en een die er een krijgt komt er nooit in — en het scherm waarop je
 * dat zou zien is precies het scherm dat op die index leunt.
 *
 * ── WAAROM TELLEN EN NIET OPSOMMEN ──────────────────────────────────
 *
 * Dat is de les van W5, letterlijk: daar leefde de reconcile in de routes,
 * werd één bestand genoemd, en hielden ZEVEN van de acht save-paden in dat
 * bestand vrolijk de rijen van de vorige versie vast. Een lijst die "dit
 * bestand doet het" zegt, zegt niets over de acht handlers erin.
 *
 * Hier zijn het er TIEN, verdeeld over vier bestanden:
 *   routes/studioApps.js                     4 — aanmaken, definitie opslaan,
 *                                                sjabloon-upgrade, versie terugzetten
 *   projects/packaging/install.js            2 — een app uit een Oplossing
 *   projects/packaging/upgrade.js            1 — een app die een upgrade vervangt
 *   appStudio/builderTools/persistence.js    3 — de AI-bouwer (create + save + retry)
 *
 * Ze gaan alle tien door DRIE storefuncties, en dáár hangt de reconcile —
 * niet in de routes. Dat is de tweede helft van de W5-les: zolang de
 * schrijvers zelf herindexeren, kan een NIEUWE aanroeper geen gat openen, hij
 * kan hoogstens ongedocumenteerd zijn. De sterke test hieronder is daarom
 * mechanisch: hij zoekt in de store ELKE plek die `studio_apps.definition`
 * schrijft, leidt de omvattende functie af, en eist dat die functie via haar
 * herindexerende wrapper wordt geëxporteerd. Een vierde schrijver die er ooit
 * bij komt is dan rood, niet stil.
 *
 * Run: cd server && node --test --test-reporter=tap appStudio/automationUsage.savePaths.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const SERVER = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(SERVER, rel), 'utf8');

const STORE = 'stores/studioAppStore.js';

/**
 * De aanroepplekken die een app-definitie wegschrijven, per bestand met het
 * minimum dat er moet staan. GETELD: één bestand noemen zou zeven van de tien
 * paden vrij laten, precies zoals bij de webpagina's.
 */
const DEFINITION_WRITE_SITES = [
    // aanmaken · definitie opslaan · sjabloon-upgrade · versie terugzetten
    { file: 'routes/studioApps.js', atLeast: 4 },
    // een app uit een Oplossing: aangemaakt, en daarna met haar definitie gevuld
    { file: 'projects/packaging/install.js', atLeast: 2 },
    // een app die door een Oplossing-upgrade wordt VERVANGEN
    { file: 'projects/packaging/upgrade.js', atLeast: 1 },
    // de AI-bouwer: create, save, en de save-na-conflict
    { file: 'appStudio/builderTools/persistence.js', atLeast: 3 },
];

/** Een aanroep van een van de drie definitieschrijvers. */
const WRITE_CALL = /\b(createStudioApp|saveDefinition|restoreVersion)\s*\(/g;

test('tien aanroepplekken bewaren een app-definitie, verdeeld over vier bestanden', () => {
    let total = 0;
    for (const { file, atLeast } of DEFINITION_WRITE_SITES) {
        const found = (read(file).match(WRITE_CALL) || []).length;
        assert.ok(found >= atLeast,
            `${file}: ${found} aanroep(en) die een definitie bewaren, verwacht minstens ${atLeast} — `
            + 'is er een save-pad verdwenen, of heet de storefunctie anders?');
        total += found;
    }
    assert.ok(total >= 10, `samen ${total} aanroepplekken, verwacht minstens 10`);
});

// ── de mechanische helft: welke storefuncties schrijven de definitie? ──

/**
 * Elke plek in de store die `studio_apps.definition` schrijft, met de
 * omvattende functienaam.
 *
 * Drie vormen, want er zijn drie manieren om die kolom te raken:
 *   INSERT INTO studio_apps (… definition …)
 *   SET definition = $n::jsonb
 *   sets.push(`definition = …`)      — de dynamische SET-bouwers
 * `published_definition` matcht hier niet (`\b` grijpt niet na een underscore).
 * Die kolom is een KOPIE en heeft zijn eigen schrijver — `setStudioAppPublished`
 * — die sinds de sluitronde van P4 óók herindexeert, want de reconciler bouwt de
 * UNIE van draft en published: bezoekers draaien de gepubliceerde kopie. Zie de
 * aparte test verderop.
 */
function definitionWritersIn(src) {
    const fnAt = [...src.matchAll(/async function (\w+)\s*\(/g)].map(m => ({ at: m.index, name: m[1] }));
    const enclosing = (at) => {
        let best = null;
        for (const f of fnAt) { if (f.at < at) best = f.name; else break; }
        return best;
    };

    const out = new Map();   // functienaam → [de statements die het bewijzen]
    const note = (at, what) => {
        const fn = enclosing(at);
        if (!fn) return;
        if (!out.has(fn)) out.set(fn, []);
        out.get(fn).push(what);
    };

    for (const m of src.matchAll(/INSERT INTO studio_apps\s*\(([^)]*)\)/g)) {
        if (/\bdefinition\b/.test(m[1])) note(m.index, 'INSERT');
    }
    for (const m of src.matchAll(/\bdefinition\s*=\s*\$\d+::jsonb/g)) note(m.index, 'SET');
    for (const m of src.matchAll(/sets\.push\(\s*`\s*definition\s*=/g)) note(m.index, 'dynamic SET');
    return out;
}

/**
 * De body van één functie, van haar `async function <naam>(` tot de volgende
 * functiekop. Ruw maar genoeg: de wrappers zijn allemaal een paar regels, en
 * het alternatief (haakjes tellen) zou hier alleen maar meer kunnen breken.
 */
function bodyOf(src, name) {
    const start = src.search(new RegExp(`async function ${name}\\s*\\(`));
    if (start === -1) return null;
    const rest = src.slice(start + 1);
    const next = rest.search(/\nasync function \w+\s*\(|\nmodule\.exports/);
    return next === -1 ? rest : rest.slice(0, next);
}

test('elke storefunctie die de definitie schrijft, wordt via haar herindexerende wrapper geexporteerd', () => {
    const src = read(STORE);
    const writers = definitionWritersIn(src);

    // De premisse zelf: als deze scan niets meer vindt, is hij kapot — en een
    // kapotte scan faalt niet, hij zwijgt.
    assert.ok(writers.size >= 3,
        `de scan vond ${writers.size} definitieschrijver(s) in ${STORE}; verwacht minstens 3 `
        + '(createStudioApp, saveDefinition, restoreVersion)');

    // Bewust brontekst, zoals de bestandskop zegt: dit is de mechanische
    // helft die ELKE schrijfplek in de store afloopt, inclusief een die geen
    // enkele test aandrijft. Het GEDRAG erachter (roept de wrapper de
    // reconciler ook echt aan?) staat behavioraal in
    // stores/studioAppStore.test.js — bewaakt door de laatste test hieronder.
    for (const [fn, proofs] of writers) {
        assert.match(src, new RegExp(`\\b${fn}:\\s*${fn}Indexed\\b`),
            `${STORE}: ${fn} schrijft studio_apps.definition (${proofs.join(', ')}) maar wordt niet als `
            + `\`${fn}: ${fn}Indexed\` geexporteerd — zonder wrapper houdt elk pad langs hem de rijen van de vorige versie`);
        assert.match(src, new RegExp(`async function ${fn}Indexed\\b`),
            `${STORE}: de wrapper ${fn}Indexed bestaat niet`);
    }

    // En ELKE wrapper roept de reconciler ook echt aan.
    //
    // Dit stond er als één `assert.match` over het hele bestand, en dat is
    // precies één aanroep te weinig om iets te bewijzen: met alleen de aanroep
    // in `createStudioAppIndexed` bleef de controle groen terwijl je hem uit
    // `saveDefinitionIndexed` — het pad dat élke autosave van élke app neemt —
    // kon weghalen. Nu per wrapper, op zijn eigen body.
    for (const fn of writers.keys()) {
        const body = bodyOf(src, `${fn}Indexed`);
        assert.ok(body, `${STORE}: de body van ${fn}Indexed is niet te vinden`);
        assert.match(body, /reindexRoutineUsage\(|reconcileAppAutomationUsageDetached\(/,
            `${STORE}: ${fn}Indexed herindexeert niet — zonder die aanroep blijven de rijen van de VORIGE `
            + 'definitie staan (de reconcile is delete-then-insert), en houdt een actie die haar routine '
            + 'kwijtraakt de capsule voor altijd in de lucht');
    }
    // De reconciler wordt door één helper aangeroepen, niet tien keer los.
    assert.match(src, /reconcileAppAutomationUsageDetached\(/,
        `${STORE}: de wrappers horen de routine-usage-reconciler aan te roepen`);
});

/**
 * De GEPUBLICEERDE definitie is de vijfde schrijver, en de index telt hem mee.
 *
 * De reconciler bouwt de unie van draft en published, want de vraag die de
 * capsule beantwoordt ("wie breekt er als ik dit weggooi") gaat over productie
 * en bezoekers draaien de gepubliceerde kopie. Zonder een wrapper op
 * `setStudioAppPublished` verandert publiceren en depubliceren de index niet.
 */
test('de publish-schrijver gaat ook door een herindexerende wrapper', () => {
    // Bewust brontekst, zelfde reden als hierboven.
    const src = read(STORE);
    assert.match(src, /published_definition/, 'de scan is stuk als deze kolom niet meer bestaat');
    assert.match(src, /\bsetStudioAppPublished:\s*setStudioAppPublishedIndexed\b/,
        `${STORE}: setStudioAppPublished hoort als zijn herindexerende wrapper geexporteerd te worden`);
    const body = bodyOf(src, 'setStudioAppPublishedIndexed');
    assert.ok(body, `${STORE}: setStudioAppPublishedIndexed bestaat niet`);
    assert.match(body, /reindexRoutineUsage\(/,
        `${STORE}: setStudioAppPublishedIndexed herindexeert niet — dan blijft de index de draft-stand houden `
        + 'terwijl de LIVE app een andere definitie draait');
});

/**
 * En het GEDRAG erachter — want alles hierboven leest bronbestanden.
 *
 * De echte aanroepen staan in stores/studioAppStore.test.js, met de
 * in-memory Postgres-stand-in en de reconciler vervangen door een teller. Dat
 * is de test die rood wordt als een wrapper wél bestaat maar niets doet; deze
 * regel zorgt dat hij niet stilletjes kan verdwijnen.
 */
test('de gedragstesten van de wrappers bestaan', () => {
    const behaviour = read('stores/studioAppStore.test.js');
    for (const fn of ['saveDefinition', 'createStudioApp', 'restoreVersion', 'setStudioAppPublished', 'deleteStudioApp']) {
        assert.match(behaviour, new RegExp(`store\\.${fn}\\(`),
            `stores/studioAppStore.test.js: er is geen echte aanroep van ${fn} die bewijst dat de wrapper herindexeert`);
    }
    assert.match(behaviour, /withReindexSpy/,
        'stores/studioAppStore.test.js: de teller die de reconciles opvangt is verdwenen');
});

test('beide kanten van de ontbrekende FK worden opgeruimd', () => {
    // Er is geen FK naar `studio_apps` en geen naar `automations`, dus geen van
    // beide verwijderingen ruimt zichzelf op. Blijft een rij staan, dan claimt
    // hij namens een knop of een routine die niet meer bestaat.
    // Bewust brontekst, zelfde reden als hierboven — twee bestanden, geen van
    // beide een test die dit gedrag al aandrijft.
    assert.match(read(STORE), /purgeAppAutomationUsage\(/,
        `${STORE}: een verwijderde app hoort haar rijen mee te nemen`);
    assert.match(read(STORE), /async function deleteStudioAppIndexed\b/,
        `${STORE}: de delete hoort door haar opruimende wrapper te gaan`);
    assert.match(read(STORE), /\bdeleteStudioApp:\s*deleteStudioAppIndexed\b/,
        `${STORE}: en die wrapper hoort de geexporteerde te zijn`);
    // Handoff 5: DELETE moves a routine into the trash; the final delete, and
    // this cleanup with it, is the trash purge.
    assert.match(read('jobs/automationTrashPurge.js'), /purgeUsageOfAutomation\(/,
        'jobs/automationTrashPurge.js: a purged routine takes its rows with it');
});

/** Elke .js-bron onder server/, minus dependencies, tests en vendored code. */
function* sources(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (['node_modules', '.git', 'vendor', 'dist', 'coverage'].includes(entry.name)) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) { yield* sources(full); continue; }
        if (!entry.name.endsWith('.js') || /\.test\.js$/.test(entry.name)) continue;
        yield full;
    }
}

/**
 * De andere richting, en de reden dat de lijst hierboven te vertrouwen is: wie
 * de reconciler AANROEPT moet hier staan. Een tweede aanroeper die er ooit
 * bijkomt is geen fout — hij is alleen ongedocumenteerd, en dan hoort iemand
 * te controleren of zijn buren hetzelfde doen. Precies zoals bij de webpagina's.
 */
const RECONCILER_CALLERS = [
    // De backstop. De enige plek waar "de app is veranderd" en "de index is
    // achterhaald" hetzelfde feit zijn.
    'stores/studioAppStore.js',
];
const AUTOMATION_PURGE_CALLERS = [
    'jobs/automationTrashPurge.js',   // a routine leaves the trash for good (handoff 5)
];

test('niets anders roept de app-reconciler aan zonder hier te staan', () => {
    const self = ['appStudio/automationUsageSync.js'];   // de definitie, geen aanroeper
    for (const file of sources(SERVER)) {
        const rel = path.relative(SERVER, file).split(path.sep).join('/');
        if (self.includes(rel)) continue;
        const src = fs.readFileSync(file, 'utf8');
        if (/reconcileAppAutomationUsageDetached\(|purgeAppAutomationUsage\(/.test(src)) {
            assert.ok(RECONCILER_CALLERS.includes(rel),
                `${rel} houdt automation_usage bij maar staat niet in RECONCILER_CALLERS — `
                + 'zet hem erbij, en controleer of zijn buren hetzelfde doen');
        }
    }
});

test('niets anders ruimt de routine-kant op zonder hier te staan', () => {
    const self = ['stores/automationUsageStore.js'];     // de definitie, geen aanroeper
    for (const file of sources(SERVER)) {
        const rel = path.relative(SERVER, file).split(path.sep).join('/');
        if (self.includes(rel)) continue;
        if (!/purgeUsageOfAutomation\(/.test(fs.readFileSync(file, 'utf8'))) continue;
        assert.ok(AUTOMATION_PURGE_CALLERS.includes(rel),
            `${rel} ruimt automation_usage op maar staat niet in AUTOMATION_PURGE_CALLERS`);
    }
});
