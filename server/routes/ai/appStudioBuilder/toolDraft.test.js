const test = require('node:test');
const assert = require('node:assert/strict');
const { scanAppToolDraft, deriveAppDraftKey, MAX_ITEMS } = require('./toolDraft');

test('an app_add_components batch cut mid-string: closed items typed, the open one labelled as far as typed', () => {
    const partial = '{"parentId":"sec_home01","components":[{"type":"page_header","props":{"title":"Facturen"}},{"type":"kpi","props":{"label":"Totaal excl. btw"},"style":{"span":3}},{"type":"data_grid","props":{"title":"Alle fact';
    const scan = scanAppToolDraft('app_add_components', partial);
    assert.equal(scan.parentId, 'sec_home01');
    assert.equal(scan.count, 3);
    assert.deepEqual(scan.items[0], { kind: 'component', type: 'page_header', label: 'Facturen', partial: false });
    assert.deepEqual(scan.items[1], { kind: 'component', type: 'stat', label: 'Totaal excl. btw', partial: false }, 'kpi previews as the type it lands as');
    assert.deepEqual(scan.items[2], { kind: 'component', type: 'data_grid', label: 'Alle fact', partial: true });
});

test('a type is reported only once its string has closed; children flatten after their parent', () => {
    const cut = '{"parentId":"sec_1","components":[{"type":"dat';
    assert.deepEqual(scanAppToolDraft('app_add_components', cut).items, [{ kind: 'component', type: null, label: null, partial: true }]);
    const nested = '{"parentId":"sec_1","components":[{"type":"card","props":{"title":"Box"},"children":[{"type":"heading","props":{"text":"Inside"}},{"type":"button","props":{"label":"Go"}}]},{"type":"divider"}]}';
    const scan = scanAppToolDraft('app_add_components', nested);
    assert.deepEqual(scan.items.map((i) => [i.type, i.label, i.partial]), [['card', 'Box', false], ['heading', 'Inside', false], ['button', 'Go', false], ['divider', null, false]]);
});

test('the parent is read only when terminated, and sectionId/containerId count as the parent', () => {
    assert.equal(scanAppToolDraft('app_add_components', '{"parentId":"sec_ho').parentId, null);
    assert.equal(scanAppToolDraft('app_add_components', '{"sectionId":"sec_x","components":[]}').parentId, 'sec_x');
});

test('screens, tables and actions describe one landing each; other tools describe nothing', () => {
    assert.deepEqual(scanAppToolDraft('app_add_screen', '{"name":"Factu').items, [{ kind: 'screen', type: null, label: 'Factu', partial: true }]);
    assert.deepEqual(scanAppToolDraft('app_link_datatable', '{"name":"Facturen","mode":"read"}').items, [{ kind: 'table', type: null, label: 'Facturen', partial: false }]);
    assert.deepEqual(scanAppToolDraft('app_upsert_table', '{"key":"orders","name":"Ord').items, [{ kind: 'table', type: null, label: 'Ord', partial: true }], 'the name wins over the key as the label');
    assert.deepEqual(scanAppToolDraft('app_set_action', '{"action":{"kind":"navigate","name":"Open detail","screenId":"scr').items, [{ kind: 'action', type: 'navigate', label: 'Open detail', partial: true }]);
    assert.equal(scanAppToolDraft('app_set_action', '{"actions":[{"action":{"kind":"toast"}},{"action":{"kind":"navi').count, 2);
    assert.deepEqual(scanAppToolDraft('app_update_component', '{"id":"cmp_1","props":{"text":"x"}}'), { items: [], count: 0, parentId: null });
    assert.deepEqual(scanAppToolDraft('app_finalize', ''), { items: [], count: 0, parentId: null });
});

test('never throws, caps the item count, and the key ignores label text', () => {
    assert.deepEqual(scanAppToolDraft('app_add_components', null), { items: [], count: 0, parentId: null });
    assert.deepEqual(scanAppToolDraft('app_add_components', '[1,2'), { items: [], count: 0, parentId: null });
    const many = `{"components":[${Array.from({ length: 60 }, () => '{"type":"text"}').join(',')}]}`;
    assert.equal(scanAppToolDraft('app_add_components', many).count, MAX_ITEMS);
    const a = deriveAppDraftKey(scanAppToolDraft('app_add_components', '{"parentId":"s","components":[{"type":"text","props":{"text":"Hel'));
    const b = deriveAppDraftKey(scanAppToolDraft('app_add_components', '{"parentId":"s","components":[{"type":"text","props":{"text":"Hello wor'));
    assert.equal(a, b, 'more label text alone is not a new key');
    const c = deriveAppDraftKey(scanAppToolDraft('app_add_components', '{"parentId":"s","components":[{"type":"text","props":{"text":"Hello"}},{"type":"stat'));
    assert.notEqual(a, c, 'a new item is');
});
