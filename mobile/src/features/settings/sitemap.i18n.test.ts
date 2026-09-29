/**
 * The nineteen keys the More tab borrows from the web, held to their source.
 *
 * `sitemap.ts` deliberately labels its destinations with the WEB's own keys
 * (`sidebar.agents`, `settings.appearance`) rather than mobile-specific ones,
 * so a string an administrator has already translated for the browser appears
 * on the phone without anyone translating it twice. That decision is right and
 * this test does not argue with it. What it fixes is the hole underneath:
 *
 *   `agent-hub/src/i18n/i18nGuard.test.js` walks `agent-hub/src` and NOTHING
 *   ELSE. It never sees `mobile/`. So renaming or deleting one of these
 *   nineteen keys passes every test in the repository — and the phone's More
 *   tab silently falls back to its English `label`. No crash, no red, no
 *   message: a Dutch user's menu just turns into English one entry at a time.
 *
 * `.claude/handoff/I18N-CONVENTIES.md` §1.4 records the agreement ("wie er een
 * aanraakt, past sitemap.ts in dezelfde commit aan") and calls it KRITIEK #28.
 * An agreement with no enforcement is a comment. This is the enforcement.
 *
 * Same family as serverContract.test.ts and catalogLockstep.test.ts: reach
 * across the monorepo, read the real file as TEXT rather than require()ing it
 * (both dictionaries are large CommonJS/ESM modules and a lockstep must not
 * need a bundler to say whether a key still exists), and pin the expectation
 * on this side so the failure lands where the decision has to be made.
 *
 * Both dictionaries are checked, not one. i18nGuard's own rule 3 is that the
 * client and server key sets are identical; the phone reads the SERVER's
 * catalogue at runtime and the browser reads the client's, so a key present in
 * only one of them is already broken for somebody.
 */

import { DESTINATIONS } from './sitemap';
import { CLIENT_DICT, SERVER_DICT, readDict } from '../../i18n/dictionaryText';


const client = readDict(CLIENT_DICT);
const server = readDict(SERVER_DICT);
const keyed = DESTINATIONS.filter((d) => d.i18nKey);

describe('the sitemap keys the phone borrows from the web', () => {
    it('reads both dictionaries, so nothing below can pass vacuously', () => {
        expect(client.size).toBeGreaterThan(5000);
        expect(server.size).toBeGreaterThan(5000);
        // The count is not pinned — adding a destination is expected. What is
        // pinned is that there ARE borrowed keys, so a refactor that quietly
        // dropped every i18nKey could not turn this file into a no-op.
        expect(keyed.length).toBeGreaterThanOrEqual(19);
    });

    it.each(keyed.map((d) => [d.i18nKey as string, d.id]))(
        '%s (%s) still exists in BOTH English catalogues',
        (key, id) => {
            // When this goes red the answer is almost never to edit sitemap.ts
            // to match: it is to put the key back and add the new name beside
            // it, exactly as serverContract.test.ts says about payload fields.
            // Renaming a key is a rename in three places (both dictionaries and
            // a server/migrations/add-nl-* catalogue) plus this file.
            expect(client.has(key)).toBe(true);
            expect(server.has(key)).toBe(true);
            expect(id).toBeTruthy();
        },
    );

    it('every borrowed key is a namespace the web really owns', () => {
        // A key invented here would resolve to its own English fallback and
        // match nothing a Dutch user types into the search field — the exact
        // failure sitemap.ts's own comment warns about. Both prefixes are
        // frozen families (I18N-CONVENTIES §1.4).
        const strays = keyed.filter((d) => !/^(sidebar|settings)\./.test(d.i18nKey as string));
        expect(strays.map((d) => d.i18nKey)).toEqual([]);
    });
});

/**
 * Destinations whose phone label is deliberately NOT the catalogue's English.
 *
 * A More-tab row is a menu entry with nothing around it; a sidebar item sits
 * under a heading and beside an icon, so the web can afford one word where the
 * phone needs three. "All conversations" against `sidebar.chats` = "Chats" is
 * that decision, and it is a reasonable one.
 *
 * It has a cost, and the cost is written here rather than left to be
 * discovered: `label` is what the More tab shows when the catalogue cannot be
 * reached — offline, first launch, a self-hosted box whose server is down — so
 * these six rows RENAME THEMSELVES the moment the network comes back. The
 * Dutch a user eventually sees was also translated from the web's short form,
 * never from the sentence the phone showed them first.
 *
 * Every entry is a decision, not a backlog item. A SEVENTH may not be added
 * without looking at whether the phone's wording is worth that rename — which
 * is the whole point of listing them. The alternative, if the owner prefers
 * it, is a mobile-specific key per row in the phone's own namespace; that is a
 * product call, not something a test should make silently.
 */
const LABEL_DIFFERS_ON_PURPOSE = new Set([
    'chats',                  // "All conversations" ← sidebar.chats "Chats"
    'search',                 // "Search everything" ← sidebar.search "Search"
    'tasks',                  // "Tasks and reminders" ← sidebar.tasks "Tasks"
    'org-privacy',            // "Privacy and compliance" ← settings.compliance "Compliance"
    'admin',                  // "Administration" ← sidebar.admin "Admin"
    'notification-settings',  // "Notification settings" ← settings.notifications "Notifications"
]);

describe('the English on the phone against the English in the browser', () => {
    it('drifts only where a decision was recorded, and the list is not stale', () => {
        const drifted = keyed
            .map((d) => ({ id: d.id, key: d.i18nKey as string, label: d.label, en: server.get(d.i18nKey as string) }))
            .filter((x) => x.en !== undefined && x.en.toLowerCase() !== x.label.toLowerCase());

        // New drift → a decision to make, here, with the cost above in view.
        expect(drifted.filter((x) => !LABEL_DIFFERS_ON_PURPOSE.has(x.id))).toEqual([]);

        // …and the reverse, so the list can only ever be right: an id that has
        // stopped drifting must leave it. A stale exemption is how a list like
        // this turns into decoration.
        const drifting = new Set(drifted.map((x) => x.id));
        const stale = [...LABEL_DIFFERS_ON_PURPOSE].filter((id) => !drifting.has(id));
        expect(stale).toEqual([]);
    });
});
