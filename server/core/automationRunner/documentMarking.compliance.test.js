// @typecheck
/**
 * The compliance module's half of documentMarking.test.js: its composition registers the
 * marking resolver on the port. Genuinely textual, for the reason the header of
 * documentMarking.test.js gives: no seam exists to call runStartupTasks() for real.
 *
 * Run: cd server && node --test core/automationRunner/documentMarking.compliance.test.js
 */
const { test } = require('node:test');
const assert = require('node:assert');

test('the compliance module wires its resolver into the port', () => {
    // The line is the compliance module's registration (firstParty/compliance.register.js, on the
    // channel 'boot/ports' that boot/ports.js wirePorts opens), so it is looked for in the
    // composition text: index.js and every composition and part file.
    const src = require('../../testUtils/compositionText').compositionText();
    assert.ok(/documentMarking'\)\s*\n?\s*\.setMarkingResolver/.test(src) && /compliance\/marking'\)\.resolveMarking/.test(src),
        'the compliance module must call setMarkingResolver with compliance/marking.resolveMarking — without it every generated document is unmarked');
});
