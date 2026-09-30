import { nOf } from '../KnowledgeStudio/plural';

/**
 * "3 routines", and "1 routine" when there is one — for every kind a Solution
 * can hold.
 *
 * Two screens count the same seven things: the install wizard's first step
 * ("what it brings") and the overview card's chip row ("what is in it"). They
 * had no reason to disagree, and every reason not to: a Solution that reads
 * "2 tables" in the wizard and "2 tabellen" nowhere else is a translation bug
 * that only shows up on one of the two screens.
 *
 * ── Why each key is written out in full ─────────────────────────────────────
 *
 * A counted phrase is a singular/plural PAIR, so each kind gets two keys rather
 * than the plural-only `solutions.section_*` label a heading uses. Per the i18n
 * conventions the choice belongs to the KEY and never to a ternary around a
 * letter — `nOf` is exactly that rule with machinery under it.
 *
 * And each key is a literal INSIDE its own `nOf` call rather than composed from
 * the section name. i18nGuard reads quoted literals inside a helper call, so a
 * template-literal key would put all seven pairs — and the `_plural` halves nOf
 * derives at run time, which exist as literals nowhere — outside every check the
 * guard makes. A key no test can see is one that quietly stops existing.
 *
 * ── Why the family is still called `install_count_*` ────────────────────────
 *
 * Because it already was, and the phrase is not install-specific: "{count}
 * routines" is the same sentence wherever a Solution is counted. A second key
 * carrying identical text for the overview would be two rows for a translator
 * to keep in step, and they would drift.
 */

/**
 * The countable kinds, in the order a card lists them, each with the `kindOf`
 * name shared/kindColors uses for its icon and colour.
 *
 * `approvals` is deliberately absent and is not an oversight: the server does
 * not count them, because an approval listing is viewer-scoped and a count that
 * ignored the viewer would tell a project member how many decisions they are
 * not allowed to see. See projects/membership.js.
 */
export const COUNTED_SECTIONS = Object.freeze([
    { section: 'automations', kind: 'automation' },
    { section: 'apps', kind: 'app' },
    { section: 'webpages', kind: 'webpage' },
    { section: 'datatables', kind: 'datatable' },
    { section: 'agents', kind: 'agent' },
    { section: 'knowledgeBases', kind: 'kb' },
    { section: 'notebooks', kind: 'meeting' },
]);

const COUNT_PHRASE = {
    automations: (t, n) => nOf(t, 'solutions.install_count_automations', n, '{count} routine', '{count} routines'),
    apps: (t, n) => nOf(t, 'solutions.install_count_apps', n, '{count} app', '{count} apps'),
    webpages: (t, n) => nOf(t, 'solutions.install_count_webpages', n, '{count} page', '{count} pages'),
    datatables: (t, n) => nOf(t, 'solutions.install_count_datatables', n, '{count} table', '{count} tables'),
    agents: (t, n) => nOf(t, 'solutions.install_count_agents', n, '{count} agent', '{count} agents'),
    knowledgeBases: (t, n) => nOf(t, 'solutions.install_count_knowledge_bases', n, '{count} knowledge base', '{count} knowledge bases'),
    notebooks: (t, n) => nOf(t, 'solutions.install_count_notebooks', n, '{count} notebook', '{count} notebooks'),
};

/** The counted phrase for one section, or null for a section with no phrase. */
export function countPhrase(t, section, count) {
    const phrase = COUNT_PHRASE[section];
    return phrase ? phrase(t, count) : null;
}

/** Does this section have a counted phrase at all? */
export function hasCountPhrase(section) {
    return Object.prototype.hasOwnProperty.call(COUNT_PHRASE, section);
}
