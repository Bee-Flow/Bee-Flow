import { INTEGRATION_CATALOG as CANONICAL_CATALOG, orderCategories } from '../../../config/integrationCatalog';
import type { IntegrationEntry } from '../../../config/integrationCatalog';
import { getIntegrationIcon } from '../../../config/integrationIcons';

/**
 * The app catalogue of the agent surfaces — DERIVED, not kept separately.
 *
 * ── THE FORK THAT WAS CLOSED HERE (A2 step 4) ───────────────────────
 * This file was a separate `META` list of 27 apps next to the canonical list in
 * `config/integrationCatalog.js` (49). Two hand-written catalogues for the same
 * question, and the difference was no detail: **not one Nextcloud app was in it**.
 * A self-hosting customer could attach Nextcloud Files, Talk, Deck or Tables to an
 * automation, but not to an agent — not because that was forbidden, but because
 * the picker did not know them. The same went for GitHub, SignRequest, Maps,
 * Withings, Browse Web, Knowledge Base and Webpages.
 *
 * A fork like that always dies in the same direction: the list nearest the
 * register grows along, the copy further away does not. The canonical list sits
 * next to the org-admin and integration screens that are touched with every new
 * integration; this copy was only touched if someone remembered it existed.
 *
 * The name and path stay, because four surfaces import it that way (the wizard,
 * the legacy AgentDesigner, PlanCard and the skill editor). What this file still
 * adds is the SHAPE those surfaces need and the canonical list does not carry: an
 * icon element and a `group`.
 *
 * ── `group` IS A GATE, NOT A CATEGORY ──────────────────────────────
 * `filterAvailableIntegrations` (and two copies of it in the legacy designer) do
 * `item.group === 'google'` and hide those apps for whoever did not sign in with
 * Google. That gate may therefore NOT come from the display category: "Google
 * Maps" sits in the Google Workspace category, but runs on a server-side API key
 * (`google_maps_api_key`) and needs nothing from a Google login. Deriving it from
 * the category would hide it for exactly the people who can use it.
 *
 * That is why the OAuth list is stated explicitly here, and it is literally the list
 * that carried `group: 'google'` before this stage. So as far as the gate goes,
 * nothing changes; only the apps the gate does not concern were added.
 */

/**
 * The apps that borrow the user's Google login. Exactly the nine that carried
 * `group: 'google'` before this stage — not "everything in the Google category".
 */
const GOOGLE_OAUTH_IDS = new Set([
    'gmail', 'google-calendar', 'google-drive', 'google-sheets', 'google-docs',
    'google-slides', 'google-contacts', 'google-keep', 'google-groups',
]);

/** Dezelfde vraag voor Microsoft: de vijf die de MS-login lenen. */
const MICROSOFT_OAUTH_IDS = new Set(['outlook', 'outlook-readonly', 'ms-calendar', 'onedrive', 'ms-contacts']);

/**
 * The `group` of an app: first the two gates, then the category as a label.
 *
 * Only `'google'` has behaviour today; the rest is a group name that screens use to
 * order things. They stay because the old file had them — but nothing hangs a right
 * on them.
 */
function groupOf(item: IntegrationEntry): string {
    if (GOOGLE_OAUTH_IDS.has(item.id)) return 'google';
    if (MICROSOFT_OAUTH_IDS.has(item.id)) return 'microsoft';
    if (item.category === 'Nextcloud') return 'nextcloud';
    if (item.category === 'AI & Media') return 'platform';
    return 'third-party';
}

// In category order (the same as the integration screens), so the picker does not
// open in an arbitrary register order.
const CATEGORY_INDEX = new Map(
    orderCategories([...new Set(CANONICAL_CATALOG.map(i => i.category))]).map((c, i) => [c, i]),
);

export const INTEGRATION_CATALOG = [...CANONICAL_CATALOG]
    .sort((a, b) => {
        const byCategory = (CATEGORY_INDEX.get(a.category) ?? 99) - (CATEGORY_INDEX.get(b.category) ?? 99);
        if (byCategory !== 0) return byCategory;
        return String(a.label).localeCompare(String(b.label));
    })
    .map(item => ({
        id: item.id,
        label: item.label,
        description: item.description,
        category: item.category,
        group: groupOf(item),
        iconSvg: getIntegrationIcon(item.id),
    }));
