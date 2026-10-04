import { describe, it, expect } from 'vitest';
import { STUDIO_APPS, createFormAutomation } from './studioApps';
import { STUDIO_RECENT_SOURCES } from '../../../utils/studioRecentSources';

/**
 * The decisions ONE section made — as opposed to studioApps.test.jsx, which
 * holds the contract every section obeys (the id list, the frozen segments,
 * the categories, "kind and create travel together", the i18n ledger).
 *
 * The split is not cosmetic: the two files fail for different reasons. A
 * failure there means the registry's shape moved and every section is
 * affected; a failure here means one section's own reasoning was undone — the
 * deep-link decision that keeps a form's URL token out of the address bar, the
 * gate that keeps a permission check on the server. Those reasons are written
 * out beside each assertion, because they are the part a later change will be
 * tempted to "simplify".
 */

const app = (id) => STUDIO_APPS.find((a) => a.id === id);

// The gate context Sidebar.jsx passes to gate(): the legacy trio plus the
// EntitlementsContext pair. Same shape as studioApps.test.jsx's.
const ctx = ({ features = [], canUseIds = [], perms = [], canIds = [], user = {} } = {}) => ({
    user,
    hasLicenseFeature: (f) => features.includes(f),
    canUse: (id) => canUseIds.includes(id),
    hasPermission: (p) => perms.includes(p),
    can: (id) => canIds.includes(id),
    lockReason: () => null,
});

describe('the Forms section — a directory, and the reasons it is only that', () => {
    const forms = () => app('forms');

    it('counts what GET /api/studio/counts calls `forms`, not its own id', () => {
        // The rail reads `countKey || id`, and the server's key IS 'forms', so
        // this happens to agree today. Pinned anyway: the count and the list
        // must be the same population, and routes/studio/counts.js applies the
        // list route's dedupe and its "the trigger must still BE a form" filter
        // to get there.
        expect(forms().countKey).toBe('forms');
        expect(forms().kind).toBe('form');
        expect(forms().category).toBe('build');
    });

    it('deep-links by the AUTOMATION id only — the page token is a credential and never travels', () => {
        // `form.id` IS the public URL token (stores/automationStore/forms.js —
        // 192 bits, no second factor). The Form page is addressed by the
        // automation behind the form (`initialFormId` = automationId), so the
        // token is never in the address bar or the history. Two things keep it
        // that way, asserted rather than trusted: no legacy alias, and no entry
        // in the recents registry — whose sub-panel navigates to
        // `studio/<segment>/<item.id>` with the ROW id.
        expect(forms().legacySegments).toBeUndefined();
        expect(STUDIO_RECENT_SOURCES.forms).toBeUndefined();
        const props = forms().getProps({ user: { id: 'u1' }, initialFormId: 'auto_1', initialFormTab: 'answers', onNavigate: null, hasPermission: () => true });
        expect(props.initialFormId).toBe('auto_1');
        expect(props.initialFormTab).toBe('answers');
    });

    it('"New form" opens the section\'s own dialog — the answers choice is made before the automation exists', () => {
        const calls = [];
        forms().create.onCreate({ onNavigate: (target) => calls.push(target) });
        expect(calls).toEqual(['studio/forms/new']);
        // the old one-shot creator still exists for callers that want a form automation straight away
        expect(typeof createFormAutomation).toBe('function');
    });
});

describe('the Runs & log descriptor (H2)', () => {
    const runs = () => app('runs');

    it('is filed under Bundle, last, with the neutral glyph the artboard draws', () => {
        // Everything above it in the rail is a thing you build; this is what
        // those things DID. Its `countKey` names the server's own key, which
        // counts the CALLER's runs in the last 24 hours — the same window and
        // the same scope the section opens on (routes/studio/counts.js).
        expect(runs().category).toBe('bundle');
        expect(runs().countKey).toBe('runs');
        expect(runs().kind).toBeUndefined();
        expect(runs().Icon).toBeTruthy();
    });

    it('addresses one run by QUERY, and carries no deep-link registry entry', () => {
        // `?run=<id>` on the section's own URL — the same query state the
        // builder uses — so there is no `/:id` path segment to grow, and no
        // recents entry (whose sub-panel navigates to
        // `studio/<segment>/<item.id>`). A run is not a thing you edited.
        expect(runs().legacySegments).toBeUndefined();
        expect(STUDIO_RECENT_SOURCES.runs).toBeUndefined();
    });

    it('gates like the rest of the /api/automation mount, and no further', () => {
        // Seeing the ORGANISATION's runs instead of your own is a separate
        // permission (manage_automations) that only the server checks, per
        // request. If this gate ever grew that check, a stale permission list
        // in the browser would decide who may ask.
        const gate = runs().gate;
        expect(gate(ctx({ features: ['automations'], canUseIds: ['automations'] }))).toBe(true);
        expect(gate(ctx({ features: ['automations'], canUseIds: [] }))).toBe(false);
        expect(gate(ctx({ features: [], canUseIds: ['automations'] }))).toBe(false);
        expect(gate(ctx({ perms: ['manage_automations'] }))).toBe(false);
    });
});
