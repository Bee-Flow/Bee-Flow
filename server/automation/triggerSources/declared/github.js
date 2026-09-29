/**
 * GitHub. Hidden: the inbound webhook uses a single global secret with no
 * installation-to-organisation mapping, so it cannot be offered without a
 * cross-tenant isolation gap. The declaration exists only so already-saved
 * automations keep resolving a label.
 *
 * Migrated verbatim from the hardcoded TRIGGER_PROVIDERS array and the
 * TRIGGER_FIELDS_BY_EVENT / TRIGGER_OUTPUT_SAMPLES maps. The catalog payload is
 * guarded byte-for-byte by triggerRegistry.golden.test.js.
 */
module.exports = { TRIGGER_SOURCES: [{
        id: 'github',
        label: 'GitHub',
        order: 80,
        defaultEvent: 'push',
        hidden: true,
        events: [],
    }] };
