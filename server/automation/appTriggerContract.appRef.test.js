/**
 * The app_trigger BACK-POINTER (`trigger.appRef`) — shape rules, and the fact
 * that automation/validate.js actually applies them.
 *
 * Kept beside the older appTriggerContract.test.js rather than inside it: that
 * file is a flat script of bare asserts, this one needs node:test cases so a
 * failure names the rule that broke.
 *
 * Run: cd server && node --test --test-reporter=tap automation/appTriggerContract.appRef.test.js
 * No DB — pure functions, and validateDefinition is pure too.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const {
    appTriggerRef,
    validateAppTriggerRef,
} = require('./appTriggerContract');
const { validateDefinition } = require('./validate');

const REF = Object.freeze({ appId: '5f2a1c34-8b7d-4e19-9f00-2ab3c4d5e6f7', screenId: 'scr_dash01', nodeId: 'cmp_btn123' });

const codes = (issues) => issues.map((i) => i.code);

describe('validateAppTriggerRef — shape only', () => {
    test('a complete ref is valid, and an absent one is legal', () => {
        assert.deepEqual(validateAppTriggerRef(REF), []);
        // An automation written by hand, or made before the back-pointer existed,
        // simply has none. That is not a broken automation.
        assert.deepEqual(validateAppTriggerRef(undefined), []);
        assert.deepEqual(validateAppTriggerRef(null), []);
    });

    test('a HALF-written ref is rejected — two thirds of a pointer names nothing', () => {
        assert.deepEqual(codes(validateAppTriggerRef({ appId: REF.appId })), ['ref_incomplete', 'ref_incomplete']);
        assert.deepEqual(codes(validateAppTriggerRef({ appId: REF.appId, screenId: REF.screenId })), ['ref_incomplete']);
        // Empty string is absence wearing a type.
        assert.deepEqual(codes(validateAppTriggerRef({ ...REF, screenId: '' })), ['ref_incomplete']);
    });

    test('ids must look like the ids App Studio mints', () => {
        // Screen/node ids are (scr|sec|cmp|act)_<6-12>; a screen id in the node
        // slot is fine by shape (the resolver catches the rest), a free-text
        // one is not.
        assert.deepEqual(codes(validateAppTriggerRef({ ...REF, nodeId: 'my button' })), ['ref_id']);
        assert.deepEqual(codes(validateAppTriggerRef({ ...REF, screenId: 'screen-1' })), ['ref_id']);
        // An app id is a UUID; anything with a path separator in it is someone
        // building a URL, not naming an app.
        assert.deepEqual(codes(validateAppTriggerRef({ ...REF, appId: '../../etc/passwd' })), ['ref_id']);
        assert.deepEqual(codes(validateAppTriggerRef({ ...REF, appId: 'a'.repeat(65) })), ['ref_id']);
    });

    test('a non-object ref is one issue, not three', () => {
        assert.deepEqual(codes(validateAppTriggerRef('app:1:2:3')), ['ref_shape']);
        assert.deepEqual(codes(validateAppTriggerRef([REF])), ['ref_shape']);
    });
});

describe('appTriggerRef — reading it back', () => {
    test('returns the three ids, and NOTHING else the caller could trust by accident', () => {
        const got = appTriggerRef({ trigger: { kind: 'app_trigger', appRef: { ...REF, canOpen: true, appName: 'Guessed' } } });
        assert.deepEqual(got, { appId: REF.appId, screenId: REF.screenId, nodeId: REF.nodeId });
    });

    test('a malformed or absent ref both read as null', () => {
        assert.equal(appTriggerRef({ trigger: { kind: 'app_trigger' } }), null);
        assert.equal(appTriggerRef({ trigger: { kind: 'app_trigger', appRef: { appId: REF.appId } } }), null);
        assert.equal(appTriggerRef(null), null);
    });
});

describe('validate.js applies the ref rules to a saved definition', () => {
    const defWith = (appRef) => ({
        trigger: { id: 'trg', type: 'trigger', kind: 'app_trigger', params: [{ name: 'q', type: 'string' }], ...(appRef === undefined ? {} : { appRef }) },
        steps: [],
        edges: [],
    });

    test('a complete back-pointer saves', () => {
        const r = validateDefinition(defWith(REF));
        assert.equal(r.ok, true, JSON.stringify(r.errors));
    });

    test('an app_trigger with no back-pointer still saves', () => {
        assert.equal(validateDefinition(defWith(undefined)).ok, true);
    });

    test('a half-written back-pointer BLOCKS the save, with the trigger path on it', () => {
        const r = validateDefinition(defWith({ appId: REF.appId, screenId: REF.screenId }));
        assert.equal(r.ok, false);
        const issue = r.errors.find((e) => e.code === 'app_trigger.ref_incomplete');
        assert.ok(issue, `expected app_trigger.ref_incomplete, got ${JSON.stringify(r.errors)}`);
        assert.equal(issue.path, 'trigger.appRef.nodeId');
        assert.equal(issue.severity, 'error');
    });

    test('a made-up id blocks too', () => {
        const r = validateDefinition(defWith({ ...REF, screenId: 'the dashboard' }));
        assert.equal(r.ok, false);
        assert.ok(r.errors.some((e) => e.code === 'app_trigger.ref_id' && e.path === 'trigger.appRef.screenId'), JSON.stringify(r.errors));
    });

    test('the rule is app_trigger-only — a manual trigger may carry any junk it likes', () => {
        // Not an endorsement: other kinds have no back-pointer, so there is
        // nothing to check, and a rule that fired on them would make every
        // unrelated trigger unsaveable the day someone stores a note there.
        const r = validateDefinition({
            trigger: { id: 'trg', type: 'trigger', kind: 'manual', appRef: { appId: 'nope' } },
            steps: [],
            edges: [],
        });
        assert.equal(r.ok, true, JSON.stringify(r.errors));
    });
});

describe('a back-pointer never leaves the installation it names', () => {
    const { buildExport } = require('./portability');

    test('export strips it, and says why', () => {
        // It names an app, a screen and a component of ONE install. Carried
        // across, it resolves to nothing — and the trigger card is built to
        // announce that out loud, so an imported automation would arrive claiming
        // a deletion that never happened.
        const { envelope, warnings } = buildExport({
            title: 'Process claim',
            definition: {
                trigger: { id: 'trg', type: 'trigger', kind: 'app_trigger', params: [], appRef: REF },
                steps: [], edges: [],
            },
        });
        assert.equal(envelope.automation.definition.trigger.appRef, undefined);
        assert.ok(warnings.some((w) => /link back to the app button/.test(w)), warnings.join(' | '));
    });

    test('the source definition is left alone — export must never mutate the row', () => {
        const definition = {
            trigger: { id: 'trg', type: 'trigger', kind: 'app_trigger', params: [], appRef: REF },
            steps: [], edges: [],
        };
        buildExport({ title: 'x', definition });
        assert.deepEqual(definition.trigger.appRef, REF);
    });

    test('an automation without one exports exactly as before — no phantom warning', () => {
        const { warnings } = buildExport({
            title: 'x',
            definition: { trigger: { id: 'trg', type: 'trigger', kind: 'manual' }, steps: [], edges: [] },
        });
        assert.ok(!warnings.some((w) => /app button/.test(w)), warnings.join(' | '));
    });
});
