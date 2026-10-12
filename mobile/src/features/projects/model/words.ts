/**
 * The words a Solution screen needs for what the server COULD NOT read, and
 * for counting what it could — ports of the web's solutionNotices.jsx
 * (sectionNames) and solutionCounts.js (COUNTED_SECTIONS, countPhrase).
 *
 * Every key is written out inside its own `t()` call, singular and plural
 * both, so the i18n guard can see each one; a key composed at run time is a
 * key no test checks.
 */

import type { TranslateFn } from '@/core/i18n';
import type { KindKey } from '@/shared/ui';

/** The singular or the plural sentence — both already translated. */
export function byCount(count: number, one: string, many: string): string {
    return count === 1 ? one : many;
}

/**
 * `unavailable` carries machine keys on purpose (the server will not send an
 * English label a Dutch reader would then see). A key with no entry falls
 * through AS ITSELF rather than being dropped: a section added on the server
 * next year must read as jargon in the strip, never as nothing.
 */
const SECTION_NAME: Readonly<Record<string, (t: TranslateFn) => string>> = {
    apps: (t) => t('solutions.section_apps', 'apps'),
    automations: (t) => t('solutions.section_automations', 'automations'),
    webpages: (t) => t('solutions.section_webpages', 'pages'),
    datatables: (t) => t('solutions.section_datatables', 'tables'),
    agents: (t) => t('solutions.section_agents', 'agents'),
    skills: (t) => t('solutions.section_skills', 'skills'),
    documentTemplates: (t) => t('solutions.section_document_templates', 'templates'),
    knowledgeBases: (t) => t('solutions.section_knowledge_bases', 'knowledge bases'),
    knowledgeSources: (t) => t('solutions.section_knowledge_sources', 'knowledge sources'),
    automationExistence: (t) => t('solutions.section_automation_existence', 'the check on which automations still exist'),
    all: (t) => t('solutions.section_all', 'everything in this Solution'),
    notebooks: (t) => t('solutions.section_notebooks', 'notebooks'),
    runs: (t) => t('solutions.section_runs', 'how often things ran'),
    completeness: (t) => t('solutions.section_completeness', 'the checks'),
    update: (t) => t('solutions.section_update', 'whether a newer version exists'),
    installedVersions: (t) => t('solutions.section_installed_versions', 'which version is installed'),
    blueprints: (t) => t('solutions.section_blueprints', 'the Blueprints kept here'),
};

function sectionName(key: string, t: TranslateFn): string {
    const name = Object.prototype.hasOwnProperty.call(SECTION_NAME, key) ? SECTION_NAME[key] : undefined;
    return name ? name(t) : key;
}

/** The section keys the server named, in the reader's own language. */
export function sectionNames(keys: readonly string[] | null | undefined, t: TranslateFn): string[] {
    return (keys ?? []).filter((k) => typeof k === 'string' && k).map((k) => sectionName(k, t));
}

/**
 * The countable kinds, in the order a card lists them. `approvals` is absent
 * on purpose: the server does not count them, because an approval listing is
 * viewer-scoped and a count that ignored the viewer would leak.
 */
export const COUNTED_SECTIONS: readonly { section: string; kind: KindKey }[] = [
    { section: 'automations', kind: 'automation' },
    { section: 'apps', kind: 'app' },
    { section: 'webpages', kind: 'webpage' },
    { section: 'datatables', kind: 'datatable' },
    { section: 'agents', kind: 'agent' },
    { section: 'knowledgeBases', kind: 'kb' },
    { section: 'notebooks', kind: 'meeting' },
    { section: 'skills', kind: 'skill' },
    { section: 'documentTemplates', kind: 'document' },
];

/** "3 automations", "1 automation" — for every kind a Solution can hold. */
export function countPhrase(section: string, count: number, t: TranslateFn): string | null {
    const p = { count };
    switch (section) {
        case 'automations':
            return byCount(count, t('solutions.install_count_automations', '{count} automation', p), t('solutions.install_count_automations_plural', '{count} automations', p));
        case 'apps':
            return byCount(count, t('solutions.install_count_apps', '{count} app', p), t('solutions.install_count_apps_plural', '{count} apps', p));
        case 'webpages':
            return byCount(count, t('solutions.install_count_webpages', '{count} page', p), t('solutions.install_count_webpages_plural', '{count} pages', p));
        case 'datatables':
            return byCount(count, t('solutions.install_count_datatables', '{count} table', p), t('solutions.install_count_datatables_plural', '{count} tables', p));
        case 'agents':
            return byCount(count, t('solutions.install_count_agents', '{count} agent', p), t('solutions.install_count_agents_plural', '{count} agents', p));
        case 'skills':
            return byCount(count, t('solutions.install_count_skills', '{count} skill', p), t('solutions.install_count_skills_plural', '{count} skills', p));
        case 'documentTemplates':
            return byCount(count, t('solutions.install_count_document_templates', '{count} template', p), t('solutions.install_count_document_templates_plural', '{count} templates', p));
        case 'knowledgeBases':
            return byCount(count, t('solutions.install_count_knowledge_bases', '{count} knowledge base', p), t('solutions.install_count_knowledge_bases_plural', '{count} knowledge bases', p));
        case 'notebooks':
            return byCount(count, t('solutions.install_count_notebooks', '{count} notebook', p), t('solutions.install_count_notebooks_plural', '{count} notebooks', p));
        default:
            return null;
    }
}
