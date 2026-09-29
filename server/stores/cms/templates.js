// @typecheck
// Page templates — global, not site-scoped: reusable block arrays a user can
// apply when creating a new page in any site.

const configStore = require('../configStore');
const { KEY_TEMPLATES, newId, clone } = require('./shared');

// ── Page templates (global, not site-scoped) ─────────────────────────
//
// Templates are reusable page block-arrays a user can apply when creating
// a new page. Stored as one flat array under KEY_TEMPLATES. Each entry:
//   { id, name, description, createdAt, blocks: [...] }
// where `blocks` is a deep-cloned snapshot of a page's blocks taken at
// save time. IDs inside blocks are NOT regenerated at save — they are
// regenerated at APPLY time, so the saved entry is portable across sites
// and stable to delete-without-affecting copies.

async function getTemplates() {
    const raw = await configStore.getConfig(KEY_TEMPLATES);
    if (!Array.isArray(raw)) return [];
    return raw;
}

async function setTemplates(list) {
    const sanitized = Array.isArray(list) ? list : [];
    await configStore.setConfig(KEY_TEMPLATES, sanitized);
}

/**
 * @param {{ name?: string, description?: string, blocks?: any[] }} [opts]
 */
async function saveTemplate({ name, description, blocks } = {}) {
    const trimmedName = String(name || '').trim();
    if (!trimmedName) throw new Error('Template name is required');
    if (!Array.isArray(blocks)) throw new Error('Template blocks must be an array');
    const list = await getTemplates();
    const entry = {
        id: newId('tpl'),
        name: trimmedName.slice(0, 200),
        description: String(description || '').slice(0, 500),
        createdAt: new Date().toISOString(),
        blocks: clone(blocks),
    };
    list.push(entry);
    await setTemplates(list);
    return entry;
}

async function deleteTemplate(id) {
    if (!id) throw new Error('Template id is required');
    const list = await getTemplates();
    const next = list.filter(t => t.id !== id);
    await setTemplates(next);
}

// Returns a deep copy of the template's blocks with FRESH block IDs so
// it's safe to drop directly into a new page. Throws when the template
// doesn't exist so callers can surface a clear error to the user.
async function applyTemplate(id) {
    if (!id) throw new Error('Template id is required');
    const list = await getTemplates();
    const tpl = list.find(t => t.id === id);
    if (!tpl) throw new Error('Template not found');
    const blocks = Array.isArray(tpl.blocks) ? tpl.blocks : [];
    return blocks.map(b => ({ ...clone(b), id: newId('blk') }));
}

module.exports = {
    getTemplates, setTemplates, saveTemplate, deleteTemplate, applyTemplate,
};
