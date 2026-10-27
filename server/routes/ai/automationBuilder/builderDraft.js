/** @typedef {import('./turnSetup').BuilderDraftWrap} BuilderDraftWrap */
// @typecheck strict
/**
 * Automation Builder — the in-progress draft: load-or-create for a
 * (userId, builderSessionId) pair, and the write-through persist that every
 * mutation goes through.
 */

const automationStore = require('../../../stores/automationStore');
const { emptyDefinition } = require('../../../automation/builderTools');
const { UNTITLED_AUTOMATION, MAX_TITLE } = require('../../../automation/builderTools/deriveTitle');

/**
 * A title/description a HOST hands the builder for a draft it creates — the
 * playbook's automation stage sends the `Title "…"` its brief carries, so the
 * automation is named from its first persisted byte instead of after the model
 * gets round to builder_set_metadata (or never does). Only strings, clamped
 * to the title cap; anything else is ignored rather than refused, and the
 * seed is NEVER applied to an existing draft — a name the person or the
 * model chose is not overwritten by a host re-sending its brief.
 * @param {{ title?: string; description?: string; } | null} seedMetadata
 */
function seedFor(seedMetadata) {
    const seed = seedMetadata && typeof seedMetadata === 'object' && !Array.isArray(seedMetadata) ? seedMetadata : {};
    const title = typeof seed.title === 'string' ? seed.title.replace(/\s+/g, ' ').trim().slice(0, MAX_TITLE) : '';
    const description = typeof seed.description === 'string' ? seed.description.trim().slice(0, 500) : '';
    return { title: title || UNTITLED_AUTOMATION, description };
}

/**
 * @typedef {Object} LoadOrCreateDraftArgs
 * @property {string} userId
 * @property {string | null} [builderSessionId]
 * @property {string | null} [automationId]
 * @property {{ title?: string; description?: string; } | null} [seedMetadata]
 */
/**
 * @param {LoadOrCreateDraftArgs} param0
 */
async function loadOrCreateDraft({ userId, builderSessionId, automationId, seedMetadata = null }) {
    if (automationId) {
        const a = await automationStore.getAutomation(automationId);
        if (a && a.userId === userId) {
            return {
                userId,
                builderSessionId: builderSessionId || a.createdFromChatId || `bs_${Date.now().toString(36)}`,
                automationId: a.id,
                // The automation's organisation: where a table the assistant
                // creates must live (datatableCreateAccess checks it).
                orgId: a.organizationId || null,
                title: a.title,
                description: a.description,
                def: a.definition && Object.keys(a.definition).length ? a.definition : emptyDefinition(),
            };
        }
    }
    const seed = seedFor(seedMetadata);
    return {
        userId,
        builderSessionId: builderSessionId || `bs_${Date.now().toString(36)}`,
        automationId: /** @type {string | null} */ (null),
        title: seed.title,
        description: seed.description,
        def: emptyDefinition(),
    };
}

/**
 * @param {BuilderDraftWrap} draftWrap
 */
async function persistDraftWrap(draftWrap) {
    // Always-on persistence: every mutation writes through to the
    // automations table. The draft row is also returned by /api/automation
    // listings so the user sees their in-progress work in the UI.
    const { persistDraft } = require('../../../automation/builderTools');
    await persistDraft(draftWrap);
}

module.exports = { loadOrCreateDraft, persistDraftWrap, seedFor };
