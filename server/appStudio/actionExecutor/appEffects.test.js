/**
 * Wat de app terugkrijgt: `output` én `_appEffects`, uit ÉÉN pass over de
 * runstappen.
 *
 * ── DE BOTSING DIE HIER WORDT VOORKOMEN ────────────────────────────────────
 * `deriveFinalOutput` levert "de output van de LAATST uitgevoerde TOP-LEVEL
 * stap", en een `return_to_app` IS per constructie die laatste stap. Zonder een
 * uitzondering zou dus élke bestaande `actionResult`-binding in élke app van de
 * ene dag op de andere niet meer de data van de routine lezen maar het
 * effectenobject — geruisloos, op het moment dat iemand een terugkeerstap
 * toevoegt. Daarom staat `return_to_app` in NON_ANSWER_STEP_TYPES, naast
 * `trigger` en `wait`, en reizen de effecten in hun eigen veld.
 *
 * Run: cd server && node --test appStudio/actionExecutor/appEffects.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert');

const automationStore = require('../../stores/automationStore');
const { deriveFinalOutput, deriveRunOutcome, runAutomationStep } = require('./automationBridge');
const automationRunner = require('../../core/automationRunner');

/** Run the derivation against a canned list of run-step rows. */
async function withSteps(rows, fn) {
    const orig = automationStore.getRunSteps;
    automationStore.getRunSteps = async () => rows;
    try { return await fn(); } finally { automationStore.getRunSteps = orig; }
}

const EFFECTS = { toast: { message: 'Saved', tone: 'success' }, navigateTo: { screenId: 'scr_x' }, onError: 'stay' };

const ROWS = [
    { stepId: 'trig', stepType: 'trigger', parentStepId: null, output: { ignore: true } },
    { stepId: 's1', stepType: 'datatable', parentStepId: null, output: { rows: [{ id: 'ord_1' }], count: 1 } },
    { stepId: 'r1', stepType: 'return_to_app', parentStepId: null, output: { _appEffects: EFFECTS } },
];

test('the effects object never becomes the run OUTPUT — actionResult still reads the real data', async () => {
    await withSteps(ROWS, async () => {
        const { output, appEffects } = await deriveRunOutcome({ id: 'r', status: 'success' });
        assert.deepStrictEqual(output, { rows: [{ id: 'ord_1' }], count: 1 });
        assert.deepStrictEqual(appEffects, EFFECTS);
        // …and the older single-answer entry point agrees, since it is the
        // same pass: a caller that only wants the output cannot accidentally
        // get the effects.
        assert.deepStrictEqual(await deriveFinalOutput({ id: 'r', status: 'success' }), output);
    });
});

test('a run with no return step answers exactly as it always did — no new field at all', async () => {
    await withSteps(ROWS.slice(0, 2), async () => {
        const { output, appEffects } = await deriveRunOutcome({ id: 'r', status: 'success' });
        assert.deepStrictEqual(output, { rows: [{ id: 'ord_1' }], count: 1 });
        assert.strictEqual(appEffects, null);
    });
});

test('a routine whose ONLY step is the return has no answer to give, but still has instructions', async () => {
    await withSteps([ROWS[0], ROWS[2]], async () => {
        const { output, appEffects } = await deriveRunOutcome({ id: 'r', status: 'success' });
        assert.strictEqual(output, null, 'the effects are not data');
        assert.deepStrictEqual(appEffects, EFFECTS);
    });
});

test('a failed run carries no instructions — the step never ran', async () => {
    await withSteps(ROWS, async () => {
        assert.deepStrictEqual(await deriveRunOutcome({ id: 'r', status: 'error' }), { output: null, appEffects: null });
    });
});

test('the LAST top-level return wins, and a nested row is never one', async () => {
    const other = { toast: { message: 'Second', tone: 'info' }, onError: 'stay' };
    await withSteps([
        ...ROWS,
        // Een regel uit een flowlet/Step: execCallLayer zet `parentStepId`
        // ('cl1/out' → 'cl1'), dus dit is de vorm die de runner daar ECHT
        // schrijft.
        { stepId: 'l1.r', stepType: 'return_to_app', parentStepId: 'l1', output: { _appEffects: { toast: { message: 'nested' } } } },
        { stepId: 'r2', stepType: 'return_to_app', parentStepId: null, output: { _appEffects: other } },
    ], async () => {
        const { appEffects } = await deriveRunOutcome({ id: 'r', status: 'success' });
        assert.deepStrictEqual(appEffects, other);
    });
});

/**
 * DE PARALLELLE TAK — de enige geneste plek die ECHT runregels oplevert.
 *
 * `parentStepId` alleen is niet genoeg, en dat was de stille aanname onder deze
 * scan. execCallLayer/execCallBlock zetten hem; execParallel NIET: die draait de
 * tak met `recordSteps:true` en laat `ctx.stepRecord` ongemoeid, dus een regel
 * uit een tak komt binnen met `parentStepId: null` en telde als top-level. En
 * een loop-body schrijft überhaupt geen regel (`recordSteps:false`), dus de
 * enige geneste vorm die hier langskomt was precies de vorm die er doorheen
 * glipte.
 *
 * De validator weigert een `return_to_app` daar sinds P4 hard
 * (`return_to_app.nested_forbidden`), maar een definitie van vóór die regel of
 * met de hand geschreven komt hier nog steeds langs — en dan zou de app "we
 * zijn klaar, ga hierheen" krijgen terwijl de andere takken en alles ná de
 * parallel nog draaien.
 */
test('een return in een PARALLELLE TAK telt niet als top-level — die run is niet klaar', async () => {
    await withSteps([
        ROWS[0], ROWS[1],
        // Precies wat runDag in een tak schrijft: parentStepId null, branchIndex gezet.
        { stepId: 'b0r', stepType: 'return_to_app', parentStepId: null, branchIndex: 0, output: { _appEffects: EFFECTS } },
    ], async () => {
        const { output, appEffects } = await deriveRunOutcome({ id: 'r', status: 'success' });
        assert.strictEqual(appEffects, null, 'een tak beeindigt de run niet, dus hij mag de app niet wegsturen');
        assert.deepStrictEqual(output, { rows: [{ id: 'ord_1' }], count: 1 }, 'en de output blijft ongemoeid');
    });
});

test('…terwijl dezelfde regel ZONDER branchIndex wel telt — anders bewijst de test hierboven niets', async () => {
    for (const branchIndex of [null, undefined]) {
        await withSteps([
            ROWS[0], ROWS[1],
            { stepId: 'r1', stepType: 'return_to_app', parentStepId: null, branchIndex, output: { _appEffects: EFFECTS } },
        ], async () => {
            const { appEffects } = await deriveRunOutcome({ id: 'r', status: 'success' });
            assert.deepStrictEqual(appEffects, EFFECTS, `branchIndex ${branchIndex} hoort top-level te zijn`);
        });
    }
});

/**
 * EEN MISLUKTE LEES IS GEEN "GEEN INSTRUCTIES".
 *
 * Als `getRunSteps` gooit (DB-hik, timeout) was het antwoord byte-identiek aan
 * dat van een routine zónder terugkeerstap: `_appEffects` ontbreekt gewoon in
 * het runbody, de bezoeker ziet niets gebeuren en er is geen enkel spoor. Voor
 * `output` was dat bestaand gedrag; aan diezelfde stille tak hangt sinds P4 een
 * NIEUWE belofte. De vlag reist mee, zodat de app het kan zeggen.
 */
test('een stappenlees die omvalt zegt dat, in plaats van "er waren geen instructies"', async () => {
    const orig = automationStore.getRunSteps;
    automationStore.getRunSteps = async () => { throw new Error('pool timeout'); };
    const realError = console.error;
    console.error = () => {};
    try {
        const out = await deriveRunOutcome({ id: 'r', status: 'success' });
        assert.deepStrictEqual({ output: out.output, appEffects: out.appEffects }, { output: null, appEffects: null });
        assert.strictEqual(out.effectsUnknown, true,
            'zonder deze vlag is een mislukte lees niet te onderscheiden van een run zonder terugkeerstap');
    } finally {
        automationStore.getRunSteps = orig;
        console.error = realError;
    }
});

test('een GESLAAGDE lees zegt niets over onbekend — de vlag is er alleen bij een storing', async () => {
    await withSteps(ROWS, async () => {
        const out = await deriveRunOutcome({ id: 'r', status: 'success' });
        assert.strictEqual(out.effectsUnknown, undefined);
    });
});

test('het runbody draagt de vlag als een eigen veld, niet als een leeg _appEffects', () => {
    // Bewust brontekst: routes/studioAppsRun.js is een Express-router met een
    // stapel eigen afhankelijkheden (rlsGateway, actionExecutor, runEventBus,
    // rate limiters, …). De volle bedrading staat al apart getest in
    // routes/studioAppsRun.test.js (1000+ regels, buiten dit bestand); die
    // hier verdubbelen zou dit bestand — dat over de AFLEIDING gaat, niet over
    // de route — met dezelfde omvang bezwaren.
    const fs = require('node:fs');
    const path = require('node:path');
    const src = fs.readFileSync(path.resolve(__dirname, '../../routes/studioAppsRun.js'), 'utf8');
    assert.match(src, /_appEffectsUnknown/,
        'routes/studioAppsRun.js moet de derde stand doorgeven — anders valt hij samen met "geen instructies"');
    assert.match(src, /effectsUnknown \? \{ _appEffectsUnknown: true \} : \{\}/,
        'en alleen bij een echte storing, zodat een normaal antwoord byte-identiek blijft');
});

test('a return row with a malformed payload yields nothing rather than a broken effects object', async () => {
    for (const bad of [null, 'oops', [1, 2], { _appEffects: 'nope' }, { _appEffects: ['a'] }]) {
        await withSteps([ROWS[0], ROWS[1], { stepId: 'r1', stepType: 'return_to_app', parentStepId: null, output: bad }], async () => {
            const { output, appEffects } = await deriveRunOutcome({ id: 'r', status: 'success' });
            assert.strictEqual(appEffects, null, `payload ${JSON.stringify(bad)} must not become an effects object`);
            assert.deepStrictEqual(output, { rows: [{ id: 'ord_1' }], count: 1 }, 'and the real output is unaffected');
        });
    }
});

test('the two run endpoints answer from ONE builder, so the direct and the polled reply cannot drift', () => {
    // Bewust brontekst, zelfde reden als hierboven: dezelfde zware route.
    const fs = require('node:fs');
    const path = require('node:path');
    const src = fs.readFileSync(path.resolve(__dirname, '../../routes/studioAppsRun.js'), 'utf8');
    assert.strictEqual((src.match(/await runBody\(run\)/g) || []).length, 2,
        'both /run and /actions/runs/:runId must answer through runBody');
    assert.match(src, /\.\.\.\(appEffects \? \{ _appEffects: appEffects \} : \{\}\)/,
        '_appEffects must be a SIBLING of output, and absent when there are none');
});

test('the sequence path carries the effects too — a return must not work on a button and not in a sequence', async () => {
    // Called for real instead of read as text: a run_automation step through
    // runAutomationStep must end up with the SAME _appEffects sibling field
    // the v1 /run response gets, or a return_to_app works on a button and
    // silently does nothing inside a sequence step — the same half-covered
    // shape that once made send_email a silent no-op.
    const AUTOMATION = { id: 'auto1', userId: 'u1', definition: { trigger: { kind: 'manual' } } };
    const origGetAutomation = automationStore.getAutomation;
    const origExecute = automationRunner.executeAutomation;
    automationStore.getAutomation = async (id) => (id === 'auto1' ? AUTOMATION : null);
    automationRunner.executeAutomation = async () => ({ id: 'run1', status: 'success' });
    try {
        await withSteps(ROWS, async () => {
            const { result } = await runAutomationStep(
                { id: 'app1', userId: 'u1' },
                { automationId: 'auto1', inputMapping: {} },
                { viewerId: 'u1', formValues: {} },
            );
            assert.deepStrictEqual(result._appEffects, EFFECTS);
            assert.deepStrictEqual(result.output, { rows: [{ id: 'ord_1' }], count: 1 });
        });
        // …and when there are none, the key is ABSENT — never present-but-null,
        // which downstream code could mistake for "instructions to do nothing".
        await withSteps(ROWS.slice(0, 2), async () => {
            const { result } = await runAutomationStep(
                { id: 'app1', userId: 'u1' },
                { automationId: 'auto1', inputMapping: {} },
                { viewerId: 'u1', formValues: {} },
            );
            assert.strictEqual('_appEffects' in result, false);
        });
    } finally {
        automationStore.getAutomation = origGetAutomation;
        automationRunner.executeAutomation = origExecute;
    }
});
