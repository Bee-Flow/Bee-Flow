// @typecheck
/**
 * THE LIST GUARD (server half) — every terminal step kind is known everywhere.
 *
 * A step kind is only terminal once EVERY reader knows it. If one place knows
 * it and another does not, the same graph is valid in one place and not in the
 * other, and someone only notices when an automation stops halfway or an editor
 * accepts an edge that the validator refuses. This file is the reason that
 * cannot happen silently: it walks the list
 * (validate/constants.js TERMINAL_STEP_TYPES) and requires per kind that each of
 * the seven server places names it.
 *
 * It therefore fails in TWO ways, and that is the intent:
 *   - a kind that is added to the list but is missing from one place;
 *   - a place that goes back to basing its rule on a type literal instead of
 *     on the shared set (then the link disappears and it can drift away
 *     again).
 *
 * The CLIENT half lives in
 * agent-hub/src/components/automation/Builder/flow/terminalSteps.test.ts:
 * that compares the browser copy with the list below and guards the five canvas
 * places plus the `end` family. Both halves are needed — no single module crosses
 * the server/agent-hub boundary.
 *
 * Run: cd server && node --test automation/validate/terminalSteps.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { TERMINAL_STEP_TYPES, VALID_STEP_TYPES, ON_ERROR_FORBIDDEN_SOURCE_TYPES, NESTED_FORBIDDEN_RULES } = require('./constants');

const SERVER = path.resolve(__dirname, '../..');
// A module may be a DIRECTORY (`dir/foo.js` → `dir/foo/index.js` with siblings
// next to it). That is still ONE module, so read it as one text — and also
// when the place after it is still called `foo.js`. Otherwise a split place
// would pass here silently because the rule it must name sits in a sibling
// file: the guard then fails OPEN,
// which is exactly the fault this file must catch.
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
 * The seven server places, each with the question that MUST hold per terminal kind.
 * A new enforcement place belongs here; a place that disappears should be struck
 * from here, not evaporate silently.
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
        what: 'een rand ná de stap wordt gemeld, met een eigen boodschap (validate/graphEdges.js)',
        check: (type) => require('./graphEdges').TERMINAL_EDGE_RULES.has(type),
        fix: 'geef de soort een entry in TERMINAL_EDGE_RULES in validate/graphEdges.js (code, severity, message, hint)',
    },
    {
        what: 'de runner dispatcht de soort (core/automationRunner/stepLeaf.js)',
        check: (type) => new RegExp(`case '${type}':`).test(read('core/automationRunner/stepLeaf.js')),
        fix: 'voeg een case toe aan runStepLeaf in core/automationRunner/stepLeaf.js — zonder die case gooit de run "Unknown step type"',
    },
    {
        what: 'het model leest de soort in de typecatalogus (automation/builderPrompt.js)',
        // The RENDERED prompt, not the source code: part of the step catalogue
        // (the canvas-only kinds) comes from builderTools/stepTypeTable.js, and the
        // model reads what comes out here.
        check: (type) => require('../builderPrompt').buildFullSystemPrompt({ catalog: { apps: [] }, codeStepEnabled: false }).includes(`  ${type}`),
        fix: 'beschrijf de soort in de stapcatalogus van builderPrompt.js (of, voor een canvas-only soort, in builderTools/stepTypeTable.js), inclusief dat er niets na komt',
    },
    {
        what: 'het model leest het on_error-verbod (builderPrompt.js + builderTools/schemas.js)',
        check: (type) => {
            const prompt = require('../builderPrompt').buildFullSystemPrompt({ catalog: { apps: [] }, codeStepEnabled: false });
            const schemas = fs.readdirSync(path.join(SERVER, 'automation/builderTools')).filter((n) => /^schema.*\.js$/.test(n) && !n.endsWith('.test.js')).sort().map((n) => read(`automation/builderTools/${n}`)).join('\n');
            // Both prohibition lists are prose that may run over several lines
            // ("NEVER from trigger / condition / … / <type>"), so a WINDOW after the
            // preamble instead of a single line — a list that breaks at the line break
            // would give a false green here.
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
    // The two that are on it today, by name — the data-driven loop
    // below would silently run one time fewer if one disappeared from the set, and
    // then the guard is gone without anything turning red.
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
 * The other direction: the RULE must hang on the set, not on a literal.
 *
 * Without these two, someone could extend the list and at the same time
 * put an enforcement place back on `type === 'stop_error'` — the loop above
 * then stays green (the table entry exists), while the rule applies to only
 * one kind.
 */
test('the edge rule is driven by the shared set, not by a type literal', () => {
    const src = read('automation/validate/graphEdges.js');
    assert.match(src, /TERMINAL_STEP_TYPES\.has\(stepById\.get\(e\.from\)\?\.type\)/,
        'validate/graphEdges.js must ask the shared set which steps end a run');
    assert.match(src, /TERMINAL_STEP_TYPES,?\s*\n?\s*\} = require\('\.\/constants'\)|TERMINAL_STEP_TYPES,/,
        'validate/graphEdges.js must import TERMINAL_STEP_TYPES rather than restate it');
});

test('the runner ends its walk on the shared set — the only thing that makes a terminal terminal at run time', () => {
    // This is the gap that P4 closed: `stop_error` ended a run only
    // because it THREW, so a terminal that ENDS SUCCESSFULLY had no mechanism at all.
    // Without this rule the walk simply carries on as soon as someone draws an edge,
    // and the validation warning blocks nothing.
    assert.match(read('core/automationRunner/runDag.js'), /if \(TERMINAL_STEP_TYPES\.has\(step\.type\)\) break;/,
        'runDag must stop the walk at a terminal step');
});

test('the runner re-exports the list instead of keeping a second copy', () => {
    const src = read('core/automationRunner/shared.js');
    assert.match(src, /const \{ TERMINAL_STEP_TYPES \} = require\('\.\.\/automationModel\/constants'\)/,
        'core/automationRunner/shared.js must import the terminal list, not restate it');
    assert.ok(!/TERMINAL_STEP_TYPES = new Set/.test(src),
        'a second hand-kept copy in the runner is exactly the drift this file exists to prevent');
});

/**
 * `return_to_app` has one rule that does NOT apply to every terminal, and it
 * belongs here because otherwise nothing guards it: it may not stand in a
 * flowlet or Step. `stop_error` may — it fails the whole run, and failing needs
 * no address.
 */
test('return_to_app is refused inside a flowlet/Step — a contract scope has no app to answer', () => {
    assert.match(read('automation/validate/graphNodes.js'), /layer\.return_to_app_forbidden/,
        'validate/graphNodes.js must refuse a return_to_app inside a layer/block scope');
});

/**
 * THE SECOND PLACEMENT RULE, AND THE PLACE WHERE IT WAS LONGEST MISSING.
 *
 * `graph.js` checks only TOP-LEVEL steps, so the flowlet rule above says nothing
 * about a step inside a loop body or a parallel branch. Those go through
 * `checkStep(..., { nested:true })`, and that reads exactly one list.
 * Had `return_to_app` not been in there, a loop with an end step validated
 * perfectly cleanly while the run carried on — and inside the body no run rule
 * was written at all, so the app got nothing and the run log knew nothing.
 *
 * `stop_error` does NOT belong here: it throws, and a throw does travel up through
 * every sub-graph. The loop above may therefore not enforce this rule per terminal
 * kind — hence a separate test instead of an eighth SITE.
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
    // And the rule hangs on the shared map, not on a type literal.
    assert.match(read('automation/validate/stepRules.js'), /NESTED_FORBIDDEN_RULES\.get\(step\.type\)/,
        'stepRules.js must ask the shared map which steps cannot be nested');
});
