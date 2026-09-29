'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
    PUBLIC_ROLE_KEY,
    MAX_PUBLIC_SCREENS,
    canonPublicAccess,
    resolvePublicScreens,
    resolvePublicSurface,
    buildPublicDefinition,
} = require('./publicAccess');
const { flattenSteps, normalizeSequence } = require('./actionSequence');

const collect = () => {
    const repairs = [];
    return { push: (code, path, message) => repairs.push({ code, path, message }), repairs };
};
const codes = (repairs) => new Set(repairs.map((r) => r.code));

// A definition with a PUBLIC intake screen and a PRIVATE back-office screen,
// one action wired on each, plus a nav tree naming the private one.
function definition() {
    return {
        schemaVersion: 2,
        meta: { name: 'Meterkast-intake', description: 'internal blurb', icon: 'Zap' },
        theme: { preset: 'cloud' },
        design: { radius: 'lg' },
        variables: [{ name: 'stap', type: 'number', default: 1 }],
        homeScreenId: 'scr_office',
        nav: { style: 'sidebar', groups: [{ label: 'Backoffice', screenIds: ['scr_office'] }] },
        screens: [
            {
                id: 'scr_intake',
                name: 'Aanvraag',
                sections: [{ id: 'sec_1', children: [{ id: 'btn_send', type: 'button', onClick: 'act_submit' }] }],
            },
            {
                id: 'scr_office',
                name: 'Aanvragen',
                sections: [{
                    id: 'sec_2',
                    children: [{ id: 'grid', type: 'data_grid', props: { rowActions: [{ actionId: 'act_open' }] } }],
                }],
            },
        ],
        actions: {
            act_submit: {
                kind: 'sequence',
                steps: [
                    { kind: 'create_record', tableId: 'tbl_secret', values: { naam: 'x' }, resultVar: 'newId' },
                    {
                        kind: 'condition',
                        expr: 'true',
                        then: [{ kind: 'ai_generate', prompt: 'INTERNAL PROMPT — do not leak', resultVar: 'advies' }],
                        else: [{ kind: 'toast', message: 'Bedankt' }],
                    },
                    { kind: 'send_email', to: 'planning@elektro-voorbeeld.nl', subject: 'Nieuwe aanvraag' },
                ],
            },
            act_open: { kind: 'navigate', screenId: 'scr_office' },
        },
        publicAccess: { entryScreenId: 'scr_intake', screenIds: ['scr_intake'], roleKey: 'public' },
    };
}

// ── canonPublicAccess ───────────────────────────────────────────────

test('an absent block stays absent — an app that never opted in is unchanged', () => {
    const { push, repairs } = collect();
    assert.equal(canonPublicAccess(undefined, push), null);
    assert.equal(repairs.length, 0);
});

test('a block without an entry screen is dropped, with a repair saying why', () => {
    const { push, repairs } = collect();
    assert.equal(canonPublicAccess({ screenIds: ['scr_a'] }, push), null);
    assert.ok(codes(repairs).has('publicAccess.no_entry'));
});

test('the entry screen is public by definition — listing it is optional', () => {
    const { push } = collect();
    const out = canonPublicAccess({ entryScreenId: 'scr_a' }, push);
    assert.deepEqual(out.screenIds, ['scr_a']);
    assert.equal(out.roleKey, PUBLIC_ROLE_KEY);
});

// The role is reserved because the RLS gateway recognises it BY NAME to deny
// by default; a per-app key would be indistinguishable from an ordinary role,
// and an ordinary role inherits access.default ('app' = read every row).
test('the anonymous role is reserved — a configured roleKey is ignored, loudly', () => {
    const { push, repairs } = collect();
    const out = canonPublicAccess({ entryScreenId: 'scr_a', roleKey: 'klant' }, push);
    assert.equal(out.roleKey, PUBLIC_ROLE_KEY);
    assert.ok(codes(repairs).has('publicAccess.role_reserved'));
});

test('the screen list is capped — a public page is a wizard, not a whole app', () => {
    const { push, repairs } = collect();
    const many = Array.from({ length: MAX_PUBLIC_SCREENS + 5 }, (_, i) => `scr_${i}`);
    const out = canonPublicAccess({ entryScreenId: 'scr_0', screenIds: many }, push);
    assert.equal(out.screenIds.length, MAX_PUBLIC_SCREENS);
    assert.ok(codes(repairs).has('publicAccess.too_many_screens'));
});

// ── resolvePublicScreens (pass 2) ───────────────────────────────────

test('renamed screen ids are followed, exactly as nav groups are', () => {
    const { push } = collect();
    const renames = new Map([['scr_old', 'scr_new']]);
    const out = resolvePublicScreens(
        { entryScreenId: 'scr_old', screenIds: ['scr_old'], roleKey: 'public' },
        renames,
        new Set(['scr_new']),
        push,
    );
    assert.equal(out.entryScreenId, 'scr_new');
    assert.deepEqual(out.screenIds, ['scr_new']);
});

test('an entry screen that no longer exists drops public access entirely', () => {
    const { push, repairs } = collect();
    const out = resolvePublicScreens(
        { entryScreenId: 'scr_gone', screenIds: ['scr_gone'], roleKey: 'public' },
        new Map(),
        new Set(['scr_other']),
        push,
    );
    assert.equal(out, null);
    assert.ok(codes(repairs).has('publicAccess.entry_unresolved'));
});

// ── resolvePublicSurface ────────────────────────────────────────────

test('an app that never declared publicAccess has no public surface', () => {
    const def = definition();
    delete def.publicAccess;
    assert.deepEqual(resolvePublicSurface(def), { ok: false, reason: 'not_public' });
});

test('only actions wired on a PUBLIC screen are reachable', () => {
    const surface = resolvePublicSurface(definition());
    assert.equal(surface.ok, true);
    assert.deepEqual([...surface.actionIds], ['act_submit']);
    // act_open is wired via rowActions on the back-office grid — reachable in
    // the app, invisible here.
    assert.equal(surface.actionIds.has('act_open'), false);
});

// ── buildPublicDefinition ───────────────────────────────────────────

test('the back-office screen, its action and the nav naming it never leave the process', () => {
    const def = definition();
    const pub = buildPublicDefinition(def, resolvePublicSurface(def));

    assert.deepEqual(pub.screens.map((s) => s.id), ['scr_intake']);
    assert.deepEqual(Object.keys(pub.actions), ['act_submit']);
    assert.equal(pub.nav, undefined);
    assert.equal(pub.homeScreenId, 'scr_intake');
    // A stranger must not be told what the app is for internally.
    assert.equal(pub.meta.description, '');
    // Serialising it must not carry the private screen anywhere at all.
    assert.equal(JSON.stringify(pub).includes('scr_office'), false);
});

test('server step bodies are redacted — prompts, tables and recipients stay server-side', () => {
    const def = definition();
    const pub = buildPublicDefinition(def, resolvePublicSurface(def));
    const wire = JSON.stringify(pub);

    assert.equal(wire.includes('INTERNAL PROMPT'), false);
    assert.equal(wire.includes('tbl_secret'), false);
    assert.equal(wire.includes('planning@elektro-voorbeeld.nl'), false);
    // The client still needs to know WHOSE step it is, and where to put the result.
    assert.deepEqual(pub.actions.act_submit.steps[0], { kind: 'create_record', resultVar: 'newId' });
    // A client step travels whole — the browser executes it.
    assert.equal(pub.actions.act_submit.steps[1].else[0].message, 'Bedankt');
});

// The single most important property in this file: the browser posts a step
// INDEX and the server re-resolves the step from its own unredacted copy. If
// redaction shifted the pre-order walk by even one, a visitor pressing "verstuur"
// would run a step nobody wired.
test('redaction preserves the pre-order step index exactly', () => {
    const def = definition();
    const pub = buildPublicDefinition(def, resolvePublicSurface(def));

    const serverSide = flattenSteps(normalizeSequence(def.actions.act_submit));
    const clientSide = flattenSteps(normalizeSequence(pub.actions.act_submit));

    assert.equal(clientSide.length, serverSide.length);
    assert.deepEqual(clientSide.map((s) => s.kind), serverSide.map((s) => s.kind));
});

test('a bare v1 action is redacted as the single step it is', () => {
    const def = definition();
    def.actions.act_submit = { kind: 'create_record', tableId: 'tbl_secret', values: { a: 1 } };
    const pub = buildPublicDefinition(def, resolvePublicSurface(def));
    assert.deepEqual(pub.actions.act_submit, { kind: 'create_record' });
});

// ── The public page's own look ─────────────────────────────────────────

test('publicAccess.theme / .design are PARTIAL overrides: valid knobs kept, the rest dropped with a repair', () => {
    const { push, repairs } = collect();
    const pa = canonPublicAccess({
        entryScreenId: 'scr_intake',
        theme: { canvas: '#ffda00', accent: '#009b3e', radius: 'sm', primary: 'blue', bogus: 1, density: null },
        design: { font: 'poppins', preset: 'cloud', logoUrl: 'http://not-https.example/logo.svg' },
    }, push);
    assert.deepEqual(pa.theme, { canvas: '#ffda00', accent: '#009b3e', radius: 'sm' });
    assert.deepEqual(pa.design, { font: 'poppins' });
    const c = codes(repairs);
    assert.ok(c.has('publicAccess.theme.value_invalid'), 'primary "blue"');
    assert.ok(c.has('publicAccess.theme.unknown_key'), 'bogus');
    assert.ok(c.has('publicAccess.design.unknown_key'), 'preset is provenance, not a knob');
    assert.ok(c.has('publicAccess.design.value_invalid'), 'http logo');
});

test('an override with nothing valid in it leaves the key absent — an untouched block stays byte-identical', () => {
    const { push } = collect();
    const pa = canonPublicAccess({ entryScreenId: 'scr_intake', theme: { primary: 'blue' }, design: 'poppins' }, push);
    assert.equal('theme' in pa, false);
    assert.equal('design' in pa, false);
});

test('served: the override is merged OVER the app theme and design; the app definition itself is untouched', () => {
    const def = definition();
    def.theme = { primary: '#0F766E', radius: 'md', density: 'comfortable', fontScale: 'md', appearance: 'auto' };
    def.design = { font: 'satoshi', surface: 'soft' };
    def.publicAccess = {
        entryScreenId: 'scr_intake', screenIds: ['scr_intake'], roleKey: PUBLIC_ROLE_KEY,
        theme: { canvas: '#ffda00', accent: '#009b3e', radius: 'sm' },
        design: { font: 'poppins' },
    };
    const before = JSON.stringify({ theme: def.theme, design: def.design });
    const pub = buildPublicDefinition(def, resolvePublicSurface(def));
    assert.deepEqual(pub.theme, {
        primary: '#0F766E', accent: '#009b3e', canvas: '#ffda00',
        radius: 'sm', density: 'comfortable', fontScale: 'md', appearance: 'auto',
    });
    assert.deepEqual(pub.design, { font: 'poppins', surface: 'soft' });
    assert.equal(JSON.stringify({ theme: def.theme, design: def.design }), before, 'the app keeps its own look');
});

test('served without an override: the app theme travels untouched — not re-canonicalized, not widened', () => {
    const def = definition();
    const pub = buildPublicDefinition(def, resolvePublicSurface(def));
    assert.equal(pub.theme, def.theme);
    assert.equal(pub.design, def.design);
});

/**
 * `create_record` became a top-level ACTION kind (P2), so a public form's
 * button can now be wired straight to "add a row" without a sequence around
 * it. Public delivery has to stay closed for that shape too.
 *
 * It does, and for a structural reason worth pinning rather than trusting:
 * redactAction treats a bare action as its own single step, and redactStep
 * keys off DATA_MUTATING_STEP_KINDS — which create_record has always been in.
 * If either of those two facts changes, an anonymous visitor's browser starts
 * receiving the target table id and every column binding, which is the app's
 * data model handed to the internet.
 */
test('a BARE create_record action is redacted for anonymous delivery', () => {
    const definition = {
        schemaVersion: 2,
        meta: { name: 'Intake' },
        theme: {},
        homeScreenId: 'scr_intake',
        screens: [{
            id: 'scr_intake', name: 'Intake', showInNav: true,
            sections: [{ id: 'sec_i', children: [{ id: 'cmp_b', type: 'button', props: { label: 'Send' }, onClick: 'act_add' }] }],
        }],
        actions: {
            act_add: {
                kind: 'create_record',
                tableId: 'tbl_secret',
                values: { naam: { kind: 'field', name: 'naam' }, intern: { kind: 'static', value: 'nooit tonen' } },
                resultVar: 'newId',
            },
        },
        publicAccess: { entryScreenId: 'scr_intake', screenIds: ['scr_intake'], roleKey: 'public' },
    };
    const surface = resolvePublicSurface(definition);
    const out = buildPublicDefinition(definition, surface);
    const delivered = out.actions.act_add;

    // The kind survives (the browser must know the control does something and
    // dispatch it), and the resultVar survives (later steps name it). The
    // TARGET and the DATA do not.
    assert.deepEqual(delivered, { kind: 'create_record', resultVar: 'newId' });
    const wire = JSON.stringify(out);
    assert.ok(!wire.includes('tbl_secret'), 'the target table id reached the visitor');
    assert.ok(!wire.includes('nooit tonen'), 'a column value reached the visitor');
});
