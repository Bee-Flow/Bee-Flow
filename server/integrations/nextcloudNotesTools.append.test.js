/**
 * notes_append must find the note it created before, even though Notes strips
 * file-name characters from the stored title.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const ncClient = require('./nextcloudClient');
const { json, installFakeNc, resetFakeNc } = require('./nextcloudToolFakes');

test.after(resetFakeNc);
const { executeNextcloudNotesTool } = require('./nextcloudNotesTools');
const { titleKey } = require('./nextcloudNotesAppend');

function install(notes) {
    ncClient.isConnectorSession = () => true;
    return installFakeNc(({ url, method }) => {
        if (method === 'POST') return json(200, { id: 99, title: 'x', content: '' });
        const one = url.match(/notes\/(\d+)$/);
        if (one) return json(200, { ...notes.find(x => String(x.id) === one[1]), content: 'old' });
        return json(200, notes.map(({ content, ...rest }) => rest));
    });
}

test('titleKey drops what Notes strips from a file name', () => {
    assert.equal(titleKey('X empty/slash: "q"?'), titleKey('X emptyslash q'));
});

test('append to a title with stripped characters updates the note instead of creating "(2)"', async () => {
    const calls = install([{ id: 4, title: 'X emptyslash q', category: '' }]);
    const out = await executeNextcloudNotesTool('nextcloud_notes_append', { title: 'X empty/slash: "q"?', content: 'more' }, 'u', {});
    assert.equal(out.appended, true);
    assert.equal(calls.filter(c => c.method === 'POST').length, 0);
    assert.ok(calls.some(c => c.method === 'PUT' && c.url.endsWith('/notes/4')));
});

test('with the same title in two categories the pick is deterministic: requested category, else lowest id', async () => {
    const notes = [{ id: 9, title: 'Log', category: 'b' }, { id: 3, title: 'Log', category: 'a' }, { id: 5, title: 'Log', category: 'c' }];
    let calls = install(notes);
    await executeNextcloudNotesTool('nextcloud_notes_append', { title: 'Log', content: 'z' }, 'u', {});
    assert.ok(calls.some(c => c.method === 'PUT' && c.url.endsWith('/notes/3')));
    calls = install(notes);
    await executeNextcloudNotesTool('nextcloud_notes_append', { title: 'Log', content: 'z', category: 'b' }, 'u', {});
    assert.ok(calls.some(c => c.method === 'PUT' && c.url.endsWith('/notes/9')));
});

test('the listing has no empty excerpt and no "" category', async () => {
    install([{ id: 1, title: 'A', category: '' }, { id: 2, title: 'B', category: 'work' }]);
    const list = await executeNextcloudNotesTool('nextcloud_notes_list', {}, 'u', {});
    assert.ok(list.notes.every(n => !('excerpt' in n)));
    const cats = await executeNextcloudNotesTool('nextcloud_notes_list_categories', {}, 'u', {});
    assert.deepEqual(cats.categories.map(c => c.category), ['work']);
});

test('titleKey also drops a leading # and caps the length at 100', () => {
    assert.equal(titleKey('## Plan'), titleKey('Plan'));
    assert.equal(titleKey('a'.repeat(150)), 'a'.repeat(100));
});
