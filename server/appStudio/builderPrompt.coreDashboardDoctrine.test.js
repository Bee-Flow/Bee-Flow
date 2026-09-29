/**
 * What the CORE (small-model) App Studio prompt must keep saying about call
 * size and reading order.
 *
 * The 2026-09-16 dashboard: the model followed "BATCH EVERYTHING", sent one
 * whole-screen nested app_add_components, it came back with a key that was not
 * a key and an entry with no `type`, nothing was applied, and the recovery
 * added the components one at a time — flat, in arrival order, page_header
 * last. Measured over 6 builds per variant (the real prompt, the real core
 * menu, the real few-shots, only rule 3 different): one group per call gave
 * 6/6 header-first, 6/6 cards, 6/6 finalize against 5/6, 5/6, 5/6 — with half
 * the calls and no corrupt entries at all.
 *
 * The full menu keeps the batching rule verbatim: nothing in the measurement
 * says a frontier model needs smaller calls, and its profile never sees the
 * repairs the small band leans on.
 *
 * Run: cd server && node --test --test-force-exit appStudio/builderPrompt.coreDashboardDoctrine.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert');
const { buildSystemPrompt } = require('./builderPrompt');
const { APP_CORE_TOOL_NAMES } = require('./builderModelProfiles');

const core = () => buildSystemPrompt({ toolset: 'core', catalogText: 'CATALOG' });
const full = () => buildSystemPrompt({ toolset: 'full', catalogText: 'CATALOG' });
// The full prompt numbers batching as rule 3; the core prompt (its own text
// since 2026-09-17, builderPrompt/corePrompt.js) numbers naming first and
// data second, so its group-per-call rule is found by its heading.
const rule3 = (p) => p.split('\n').find((l) => l.startsWith('3. '));
const coreRule = () => core().split('\n').find((l) => /^\d+\. ONE GROUP PER CALL/.test(l));

test('the core menu is told to send one group per call, the full menu to batch', () => {
    assert.ok(coreRule(), 'the core prompt has the one-group rule as a numbered step');
    assert.match(rule3(full()), /BATCH EVERYTHING/);
});

test('the core rule names the reading order and why it matters', () => {
    const r = coreRule();
    assert.match(r, /page_header first/i, 'the header goes first');
    assert.match(r, /order they arrive/i, 'and why: nothing re-sorts them afterwards');
});

test('the core rule states the size that is safe, not just what to avoid', () => {
    const r = coreRule();
    assert.match(r, /half a dozen entries|one row of tiles|a card with its children/,
        'a builder needs a size it CAN send, not only one it may not');
    assert.match(r, /measured 2026-09-16/i, 'the doctrine carries its evidence');
});

test('the core rule still teaches the three flat batches and the failure contract', () => {
    // Only app_add_components nests, and only nesting drifted. Taking the other
    // batches away would cost a keypad 20 calls instead of one.
    const r = coreRule();
    for (const t of ['app_update_component', 'app_set_action', 'app_bind_action']) {
        assert.ok(r.includes(t), `${t}'s batch form is still taught`);
    }
    assert.match(r, /reported at its index in `failed`/, 'partial failure is explained');
});

test('the core rule keeps strings plain: a live value is a formula or computed, never {{…}} in a string', () => {
    // The 2026-09-16 traces: a title written as "Total: {{vars.total}}" and a
    // JSON object written as a string value — both land as literal text.
    const r = coreRule();
    assert.match(r, /Keep strings plain/);
    assert.match(r, /never a string containing \{\{…\}\} or JSON/);
});

test('the core rule names no tool the core menu does not serve', () => {
    const named = new Set(coreRule().match(/\bapp_[a-z_]+/g) || []);
    const outside = [...named].filter((t) => !APP_CORE_TOOL_NAMES.has(t));
    assert.deepStrictEqual(outside, [], `the core rule may only name core tools: ${outside.join(', ')}`);
});

test('the full rule is untouched by the core wording', () => {
    const r = rule3(full());
    assert.doesNotMatch(r, /ONE GROUP PER CALL/);
    assert.match(r, /A twenty-key calculator is four calls, not seventy/, 'the original text is verbatim');
});
