/**
 * DE LIJST-BEWAKER (serverhelft) — elke terminale stapsoort is overal bekend.
 *
 * Een stapsoort is pas terminaal als ÉLKE lezer dat weet. Kent de ene plek hem
 * wel en de andere niet, dan is dezelfde graaf op de ene plek geldig en op de
 * andere niet, en dat merkt iemand pas als een automatisering halverwege stopt of een
 * editor een rand accepteert die de validator weigert. Dit bestand is de reden
 * dat dat niet stil kan gebeuren: het loopt de lijst
 * (validate/constants.js TERMINAL_STEP_TYPES) af en eist per soort dat elk van
 * de zeven serverplekken hem noemt.
 *
 * Het faalt dus op TWEE manieren, en dat is de bedoeling:
 *   - een soort die aan de lijst wordt toegevoegd maar één plek mist;
 *   - een plek die zijn regel weer op een type-literal gaat baseren in plaats
 *     van op de gedeelde set (dan verdwijnt de koppeling en kan hij opnieuw
 *     wegdrijven).
 *
 * De CLIENTHELFT staat in
 * agent-hub/src/components/automation/Builder/flow/terminalSteps.test.js:
 * die vergelijkt de browserkopie met de lijst hieronder en bewaakt de vijf
 * canvasplekken plus de `end`-familie. Beide helften zijn nodig — geen enkele
 * module kruist de server/agent-hub-grens.
 *
 * Run: cd server && node --test automation/validate/terminalSteps.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { TERMINAL_STEP_TYPES, VALID_STEP_TYPES, ON_ERROR_FORBIDDEN_SOURCE_TYPES, NESTED_FORBIDDEN_RULES } = require('./constants');

const SERVER = path.resolve(__dirname, '../..');
// Een module mag een MAP zijn (`dir/foo.js` → `dir/foo/index.js` met zusters
// ernaast). Dat is nog steeds ÉÉN module, dus lees hem als één tekst — en ook
// als de plek hierna nog `foo.js` heet. Anders zou een opgesplitste plek hier
// stilzwijgend slagen omdat de regel die hij moet noemen in een zusterbestand
// staat: de bewaker faalt dan OPEN, wat precies de storing is die dit bestand
// moet vangen.
const readDir = (dir) => fs.readdirSync(dir, { withFileTypes: true })
    .sort((a, b) => (a.name < b.name ? -1 : 1))
    .map((e) => {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) return readDir(full);
        return (e.name.endsWith('.js') && !e.name.endsWith('.test.js')) ? fs.readFileSync(full, 'utf8') : '';
    })
    .join('\n');
const read = (rel) => {
    const p = path.join(SERVER, rel);
    if (fs.existsSync(p)) return fs.statSync(p).isDirectory() ? readDir(p) : fs.readFileSync(p, 'utf8');
    const asDir = p.replace(/\.js$/, '');
    if (asDir !== p && fs.existsSync(asDir) && fs.statSync(asDir).isDirectory()) return readDir(asDir);
    return fs.readFileSync(p, 'utf8');   // bestaat niet: laat de oorspronkelijke fout zien
};

const TERMINALS = [...TERMINAL_STEP_TYPES];

/**
 * De zeven serverplekken, elk met de vraag die per terminale soort MOET
 * kloppen. Een nieuwe afdwingplek hoort hier bij te komen; een plek die
 * verdwijnt hoort hier te worden geschrapt, niet stilzwijgend te verdampen.
 */
const SERVER_SITES = [
    {
        what: 'de validator kent de soort als stapsoort',
        check: (type) => VALID_STEP_TYPES.has(type),
        fix: 'voeg de soort toe aan VALID_STEP_TYPES in validate/constants.js',
    },
    {
        what: 'een on_error-tak eruit is verboden (validate/constants.js)',
        check: (type) => ON_ERROR_FORBIDDEN_SOURCE_TYPES.has(type),
        fix: 'voeg de soort toe aan ON_ERROR_FORBIDDEN_SOURCE_TYPES — een stap die de run beëindigt kan de tak die hij belooft nooit bereiken',
    },
    {
        what: 'de LLM-zijde-spiegel van die regel (builderTools/draftGraph.js)',
        check: (type) => new RegExp(`ERROR_BRANCH_FORBIDDEN_SOURCES = new Set\\(\\[[^\\]]*'${type}'`).test(read('automation/builderTools/draftGraph.js')),
        fix: 'voeg de soort toe aan ERROR_BRANCH_FORBIDDEN_SOURCES in builderTools/draftGraph.js',
    },
    {
        what: 'een rand ná de stap wordt gemeld, met een eigen boodschap (validate/graph.js)',
        check: (type) => new RegExp(`\\['${type}', \\{`).test(read('automation/validate/graph.js')),
        fix: 'geef de soort een entry in TERMINAL_EDGE_RULES in validate/graph.js (code, severity, message, hint)',
    },
    {
        what: 'de runner dispatcht de soort (core/automationRunner/execution.js)',
        check: (type) => new RegExp(`case '${type}':`).test(read('core/automationRunner/execution.js')),
        fix: 'voeg een case toe aan runStepLeaf in core/automationRunner/execution.js — zonder die case gooit de run "Unknown step type"',
    },
    {
        what: 'het model leest de soort in de typecatalogus (automation/builderPrompt.js)',
        check: (type) => read('automation/builderPrompt.js').includes(`  ${type}`),
        fix: 'beschrijf de soort in de stapcatalogus van builderPrompt.js, inclusief dat er niets na komt',
    },
    {
        what: 'het model leest het on_error-verbod (builderPrompt.js + builderTools/schemas.js)',
        check: (type) => {
            const prompt = read('automation/builderPrompt.js');
            const schemas = read('automation/builderTools/schemas.js');
            // Beide verbodslijsten zijn proza die over meerdere regels mag
            // lopen ("NEVER from trigger / condition / … / <type>"), dus een
            // VENSTER na de aanhef in plaats van één regel — een lijst die
            // afbreekt op de regelovergang zou hier vals groen geven.
            const window = (src, marker, len) => {
                const i = src.indexOf(marker);
                return i === -1 ? '' : src.slice(i, i + len);
            };
            const inPrompt = window(prompt, 'NEVER from', 400);
            const inSchemas = window(schemas, 'NOT trigger/', 300);
            return inPrompt.includes(type) && inSchemas.includes(type);
        },
        fix: 'noem de soort in de "NEVER from …"-regel van builderPrompt.js én in de builder_wire_error_branch-beschrijving in builderTools/schemas.js',
    },
];

test('there is a terminal list at all, and everything on it is a real step type', () => {
    assert.ok(TERMINALS.length >= 2, `TERMINAL_STEP_TYPES looks empty or stale: ${JSON.stringify(TERMINALS)}`);
    // De twee die er vandaag op staan, bij naam — de datagestuurde lus
    // hieronder zou stilletjes één keer minder draaien als er eentje uit de set
    // verdween, en dan is de bewaker weg zonder dat iets rood wordt.
    assert.ok(TERMINAL_STEP_TYPES.has('stop_error'), 'stop_error is terminal — it halts the run');
    assert.ok(TERMINAL_STEP_TYPES.has('return_to_app'), 'return_to_app is terminal — it ends the run and answers the app');
});

for (const type of TERMINALS) {
    for (const site of SERVER_SITES) {
        test(`terminal "${type}": ${site.what}`, () => {
            assert.ok(site.check(type), `"${type}" is terminal but ${site.what} does not know it — ${site.fix}`);
        });
    }
}

/**
 * De andere richting: de REGEL moet aan de set hangen, niet aan een literal.
 *
 * Zonder deze twee zou iemand de lijst kunnen uitbreiden en tegelijk een
 * afdwingplek terug kunnen zetten op `type === 'stop_error'` — de lus hierboven
 * blijft dan groen (de tabel-entry bestaat), terwijl de regel alleen nog voor
 * één soort geldt.
 */
test('the edge rule is driven by the shared set, not by a type literal', () => {
    const src = read('automation/validate/graph.js');
    assert.match(src, /TERMINAL_STEP_TYPES\.has\(stepById\.get\(e\.from\)\?\.type\)/,
        'validate/graph.js must ask the shared set which steps end a run');
    assert.match(src, /TERMINAL_STEP_TYPES,?\s*\n?\s*\} = require\('\.\/constants'\)|TERMINAL_STEP_TYPES,/,
        'validate/graph.js must import TERMINAL_STEP_TYPES rather than restate it');
});

test('the runner ends its walk on the shared set — the only thing that makes a terminal terminal at run time', () => {
    // Dit is het gat dat P4 dichtte: `stop_error` eindigde een run alleen
    // doordat het GOOIT, dus een terminal die SUCCESVOL eindigt had geen enkel
    // mechanisme. Zonder deze regel loopt de wandeling gewoon door zodra iemand
    // een rand tekent, en de validatiewaarschuwing blokkeert niets.
    assert.match(read('core/automationRunner/runDag.js'), /if \(TERMINAL_STEP_TYPES\.has\(step\.type\)\) break;/,
        'runDag must stop the walk at a terminal step');
});

test('the runner re-exports the list instead of keeping a second copy', () => {
    const src = read('core/automationRunner/shared.js');
    assert.match(src, /const \{ TERMINAL_STEP_TYPES \} = require\('\.\.\/\.\.\/automation\/validate\/constants'\)/,
        'core/automationRunner/shared.js must import the terminal list, not restate it');
    assert.ok(!/TERMINAL_STEP_TYPES = new Set/.test(src),
        'a second hand-kept copy in the runner is exactly the drift this file exists to prevent');
});

/**
 * `return_to_app` heeft één regel die NIET voor elke terminal geldt, en die
 * hoort hier omdat hij anders nergens wordt bewaakt: hij mag niet in een
 * flowlet of Step staan. `stop_error` mag daar wél — die faalt de hele run,
 * en falen heeft geen adres nodig.
 */
test('return_to_app is refused inside a flowlet/Step — a contract scope has no app to answer', () => {
    assert.match(read('automation/validate/graph.js'), /layer\.return_to_app_forbidden/,
        'validate/graph.js must refuse a return_to_app inside a layer/block scope');
});

/**
 * DE TWEEDE PLAATSINGSREGEL, EN DE PLEK WAAR HIJ HET LANGST ONTBRAK.
 *
 * `graph.js` toetst alleen TOP-LEVEL stappen, dus de flowlet-regel hierboven
 * zegt niets over een stap ín een loop-body of een parallelle tak. Die lopen
 * langs `checkStep(..., { nested:true })`, en dat leest precies één lijst.
 * Stond `return_to_app` daar niet in, dan valideerde een lus met een eindstap
 * volkomen schoon terwijl de run gewoon doorliep — en in de body kwam er niet
 * eens een runregel van, dus de app kreeg niets en het runlog wist niets.
 *
 * `stop_error` hoort hier NIET in: die gooit, en een worp reist wél door elke
 * sub-graaf omhoog. De lus hierboven mag deze regel dus niet per terminale
 * soort afdwingen — vandaar een eigen test in plaats van een achtste SITE.
 */
test('return_to_app is refused inside a loop body / parallel branch — a sub-graph is not the end of the run', () => {
    assert.ok(NESTED_FORBIDDEN_RULES.has('return_to_app'),
        'NESTED_FORBIDDEN_RULES must name return_to_app — it is the only list the nested walker reads, '
        + 'and without it a "Back to the app" inside a loop or a parallel branch validates green');
    const rule = NESTED_FORBIDDEN_RULES.get('return_to_app');
    assert.equal(rule.code, 'return_to_app.nested_forbidden');
    assert.match(rule.message('x'), /loop|parallel/i);
    assert.ok(!NESTED_FORBIDDEN_RULES.has('stop_error'),
        'stop_error ends a run by THROWING, and a throw does travel up out of a sub-graph — it needs no nesting rule');
    // En de regel hangt aan de gedeelde map, niet aan een type-literal.
    assert.match(read('automation/validate/stepRules.js'), /NESTED_FORBIDDEN_RULES\.get\(step\.type\)/,
        'stepRules.js must ask the shared map which steps cannot be nested');
});
