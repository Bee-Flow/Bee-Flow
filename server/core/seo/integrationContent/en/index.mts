/**
 * en/index.mts: the English text of the public integration pages: the fixed
 * words below, the prose per integration in workspace.mts, services.mts and
 * nextcloud.mts.
 *
 * Written from docs/docs/integrations/*.md and the tool definitions in
 * server/integrations/ (where the two disagree, the tool definition is what
 * ships and wins). An integration without a doc page says what its tool
 * definitions say and nothing more. Tool and event LISTS are not written here:
 * the page takes them from the catalogues at render time (facts.mts), and the
 * prose sentences are keyed by the tool groups declared there.
 */

import type { LocaleContent } from '../types.mts';
import { WORKSPACE } from './workspace.mts';
import { SERVICES } from './services.mts';
import { NEXTCLOUD } from './nextcloud.mts';

export const EN: LocaleContent = {
    locale: 'en',
    ui: {
        navIntegrations: 'Integrations',
        navDirectory: 'Directory',
        navBlog: 'Blog',
        directoryTitle: 'Integrations directory',
        directoryHeading: 'Integrations',
        directoryLead: 'Every integration listed here is shipped in the product, with real tools behind it, and can be switched on per user, per organisation and per group.',
        directoryDescription: 'Browse the {count} integrations Bee Flow ships: Google Workspace, Microsoft 365, Nextcloud and more.',
        searchLabel: 'Search integrations',
        categoryLabel: 'Category',
        allCategories: 'All categories',
        searchButton: 'Search',
        countLine: '{shown} of {total} integrations',
        clearFilters: 'Clear filters',
        noMatch: 'No integration matches. Try a shorter search.',
        breadcrumbDirectory: 'Integrations directory',
        canDo: 'What an assistant can do',
        toolsLabel: 'Tools',
        otherTools: 'Other tools in this integration',
        effect: { reads: 'reads', writes: 'changes', sends: 'sends' },
        access: 'Read or write',
        accessText: {
            reads: 'Read-only: none of these tools change anything.',
            writes: 'These tools read and change data. The lines marked "changes" are the ones that change something.',
            sends: 'These tools read and change data, and some send something to other people, such as mail, messages or invitations. Those lines are marked "sends".',
        },
        events: 'Events that can start an automation',
        eventsNone: 'This integration has no automation events of its own.',
        eventsConnector: 'Events marked with * arrive through the Nextcloud connector; without the connector they do not fire.',
        eventsPublicUrl: 'Microsoft pushes these events, so the Bee Flow server must be reachable from the internet.',
        connect: 'How it is connected',
        gate: 'An administrator decides who may use it: integrations are switched on per user, per organisation and per group, and agents and automations call these tools only for those people.',
        limits: 'Limits',
        examples: 'Things you can ask',
        related: 'Related integrations',
        moreIn: 'More in {category}',
        browseAll: 'Browse all integrations',
        overview: 'Integrations overview',
        deployment: 'Hosting and deployment',
        plans: 'Plans',
    },
    prose: { ...WORKSPACE, ...SERVICES, ...NEXTCLOUD },
    eventLabels: {},
    categories: {},
};
