/**
 * App Studio builder: the on-request TOPICS of app_inspect_catalog.
 *
 * The cached prompt names rare material in one line (catalogDiet.mts, builderPrompt.js); a
 * topic is where that material is served, complete. A catalogue topic is the whole section as
 * catalogRender.js renders it (every signature, every rule), so nothing was rewritten on the
 * way out of the prompt; a prompt topic is the passage that used to be in the prose.
 *
 * A topic is asked by name in the `components` or `steps` list of app_inspect_catalog, written
 * "topic:<name>" (the bare name is read too). The tool's schema declares no parameter of its
 * own for it yet; an argument called `topics` is read when a caller sends one.
 */

import { createRequire } from 'node:module';
import { TOPIC_PREFIX } from './catalogDiet.mts';
import { DOCUMENTS_TOPIC, MAIL_APPS_TOPIC } from './promptTopics.mts';

type Sections = Record<string, string> & { _stepsLead: string[]; _stepNotes: string[] };

const nodeRequire = createRequire(import.meta.url);
const sections = (): Sections => (nodeRequire('./catalogRender.js') as { buildCatalogSections: () => Sections }).buildCatalogSections();

/** name → what it holds (one line, for the list of topics) and its text. */
const TOPICS: Readonly<Record<string, { holds: string; render: () => string }>> = Object.freeze({
    formulas: { holds: 'every function signature, list forms, the regex subset, operators, what a domain error returns', render: () => sections().formulas },
    sizing: { holds: 'every style knob, exact widths and heights, the fixed sidebar, pct heights, hideBelow/hideAbove', render: () => `${sections().knobs}\n${sections().advancedSizing}` },
    sequences: { holds: 'step error handling (onError, retry), the transaction step, bulk writes by filter, upsertKey and replaceWhere', render: () => [...sections()._stepsLead, ...sections()._stepNotes].join('\n') },
    actions: { holds: 'every action kind, effects, modals, call_action in full', render: () => sections().actions },
    data_model: { holds: 'field types, keys, access modes, caps, changing a table that holds rows', render: () => `${sections().dataModel}\n${sections().dataModelChanges}` },
    mail_apps: { holds: 'an app around a mailbox: message_thread, attachments, the mailbox hook', render: () => MAIL_APPS_TOPIC },
    documents: { holds: 'showing, picking, comparing and copying the owner\'s documents', render: () => DOCUMENTS_TOPIC },
    theme: { holds: 'every theme and design key', render: () => `${sections().theme}\n${sections().design}` },
    screens: { holds: 'the screen keys', render: () => sections().screen },
    node_logic: { holds: 'computed, visibleWhen, enabledWhen, readOnly, visibleToRoles, validations', render: () => sections().nodeLogic },
    bindings: { holds: 'every binding shape, filter and sort', render: () => sections().bindings },
    variables: { holds: 'declaring and reading app variables', render: () => sections().variables },
    limits: { holds: 'the size limits of a definition', render: () => sections().limits },
});

export const CATALOG_TOPIC_NAMES: readonly string[] = Object.freeze(Object.keys(TOPICS));

/** The topic a name asks for ('' for a name that is not written as a topic). */
function topicOf(name: string): string {
    const trimmed = name.trim();
    if (trimmed.toLowerCase().startsWith(TOPIC_PREFIX)) return trimmed.slice(TOPIC_PREFIX.length).trim().toLowerCase();
    return Object.hasOwn(TOPICS, trimmed) ? trimmed : '';
}

/** True for a name app_inspect_catalog reads as a topic, known or not. */
export function isTopicName(name: string): boolean {
    return topicOf(name) !== '';
}

/** The text of one topic, or null for a name that is none. */
export function renderTopic(name: string): string | null {
    return Object.hasOwn(TOPICS, name) ? TOPICS[name].render() : null;
}

export interface TopicAnswer {
    topics: Record<string, string>;
    unknown: string[];
}

/** Answer the topics among `names` (duplicates collapse). Total: an unknown topic is reported with the list. */
export function inspectTopics(names: readonly string[]): TopicAnswer {
    const answer: TopicAnswer = { topics: {}, unknown: [] };
    for (const topic of new Set(names.map(topicOf).filter(Boolean))) {
        const text = renderTopic(topic);
        if (text !== null) answer.topics[topic] = text;
        else answer.unknown.push(`${topic} is not a topic (topics: ${CATALOG_TOPIC_NAMES.join(', ')})`);
    }
    return answer;
}

/** One line per topic: what the list of topics says when none was recognised. */
export function describeTopics(): string {
    return CATALOG_TOPIC_NAMES.map((name) => `${name} (${TOPICS[name].holds})`).join('; ');
}
