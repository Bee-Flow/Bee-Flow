'use strict';

/**
 * Every step type the builder can author is named in every prompt variant, in
 * the "What you can build" block right after the role line. A band that never
 * reads a type's name cannot offer it, and the user hears "that is not
 * possible" for a step the canvas has.
 *
 * Variants: the full prompt (frontier band and the MCP guide, which is
 * buildFullSystemPrompt), and the lean prompt on both menus (small band:
 * lean; reasoning band: full) with the catalogue in the system prompt or in the
 * late message, each with code steps on and off.
 *
 * Run: cd server && node --test automation/builderPrompt.menuCoverage.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { buildFullSystemPrompt, buildLeanSystemPrompt } = require('./builderPrompt');
const { BATCH_STEP_TYPES, STEP_TYPE_TABLE } = require('./builderTools/stepTypeTable');

const CATALOG = { apps: [] };

/** @type {Array<[string, () => string]>} */
const VARIANTS = [];
for (const codeStepEnabled of [true, false]) {
    VARIANTS.push([`full, code ${codeStepEnabled}`, () => buildFullSystemPrompt({ catalog: CATALOG, codeStepEnabled })]);
    for (const menu of ['lean', 'full']) {
        for (const catalogPlacement of ['system', 'dynamic']) {
            VARIANTS.push([`lean prose, ${menu} menu, ${catalogPlacement} catalogue, code ${codeStepEnabled}`,
                () => buildLeanSystemPrompt({ catalog: CATALOG, codeStepEnabled, batchTools: true, menu, catalogPlacement })]);
        }
    }
}

/** The block, from its heading to the next top-level heading. */
function blockOf(prompt) {
    const start = prompt.indexOf('## What you can build');
    const next = prompt.indexOf('\n## ', start + 1);
    return prompt.slice(start, next === -1 ? undefined : next);
}

test('every batch step type is named in every prompt variant', () => {
    for (const [name, build] of VARIANTS) {
        const block = blockOf(build());
        const missing = BATCH_STEP_TYPES.filter((t) => !block.includes(`[${t}]`));
        assert.deepEqual(missing, [], `${name}: "What you can build" never names ${missing.join(', ')}`);
    }
});

test('every type a person can meet on the canvas is named too, canvas-only ones as such', () => {
    const shown = STEP_TYPE_TABLE.filter((e) => e.authoring !== 'retired');
    for (const [name, build] of VARIANTS) {
        const block = blockOf(build());
        for (const e of shown) assert.ok(block.includes(`- ${e.userLabel} [${e.type}] — `), `${name}: ${e.type} under its palette label`);
        for (const e of shown.filter((x) => x.authoring === 'canvas_only')) {
            assert.match(block, new RegExp(`\\[${e.type}\\] — canvas only: you cannot add it`), `${name}: ${e.type} is canvas only`);
        }
    }
});

test('the block comes first, right after the role line', () => {
    for (const [name, build] of VARIANTS) {
        const p = build();
        const firstLine = p.slice(0, p.indexOf('\n'));
        assert.match(firstLine, /^You are the BeeFlow Automation Builder\./, `${name}: role line first`);
        assert.equal(p.indexOf('## '), p.indexOf('## What you can build'), `${name}: the first section is the block`);
        assert.ok(p.slice(firstLine.length).startsWith('\n\n## What you can build\n'), `${name}: nothing between the role line and the block`);
    }
});

test('the code step line follows the flag in every variant', () => {
    for (const [name, build] of VARIANTS) {
        const block = blockOf(build());
        const on = name.endsWith('code true');
        assert.equal(/- Code \[code\] — your own JavaScript/.test(block), on, `${name}: enabled line`);
        assert.equal(/- Code \[code\] — switched off on this server; never propose it\./.test(block), !on, `${name}: disabled line`);
    }
});
