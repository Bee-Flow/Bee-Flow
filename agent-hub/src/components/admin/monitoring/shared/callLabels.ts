// Human names for what the usage ledger stores as identifiers: the placeholder
// agent name a direct chat is logged under ('direct-chat'), an agent type
// ('chat', 'automation'), and a source that is not its area's own
// ('chat_title' under Direct chat). The ledger keeps the identifiers; only
// the screen names them.
import type { TranslateFn } from '@/hooks/useTranslation';
import { areaMeta, usageSourceDetails } from '@/components/shared/usageAreaMeta';

/** Agent names that are a writer's placeholder, not an agent someone made. */
const PLACEHOLDER_AGENT_NAMES: Readonly<Record<string, { key: string; fallback: string }>> = {
    'direct-chat': { key: 'admin_polish.call_direct_chat', fallback: 'Direct chat' },
};

/** What a call was for, per source the area name alone does not say. */
const SOURCE_PURPOSES: Readonly<Record<string, { key: string; fallback: string }>> = {
    chat_title: { key: 'admin_polish.source_chat_title', fallback: 'naming the conversation' },
    agent_stream: { key: 'admin_polish.source_agent_stream', fallback: 'answer' },
    agent_chat: { key: 'admin_polish.source_agent_chat', fallback: 'answer' },
    agent_test_chat: { key: 'admin_polish.source_agent_test_chat', fallback: 'test chat' },
    automation_builder: { key: 'admin_polish.source_automation_builder', fallback: 'building with AI' },
    cowork_planner: { key: 'cowork_plan.usage.planner', fallback: 'making a plan' },
    knowledge_embedding: { key: 'admin_polish.source_knowledge_embedding', fallback: 'indexing documents' },
    kb_summary: { key: 'admin_polish.source_kb_summary', fallback: 'summarising documents' },
    meeting_summary: { key: 'admin_polish.source_meeting_summary', fallback: 'summary' },
    meeting_actions: { key: 'admin_polish.source_meeting_actions', fallback: 'action items' },
};

/** Agent types the ledger writes, as words. */
const AGENT_TYPES: Readonly<Record<string, { key: string; fallback: string }>> = {
    chat: { key: 'admin_polish.agent_type_chat', fallback: 'Chat' },
    automation: { key: 'admin_polish.agent_type_automation', fallback: 'Automation' },
    system: { key: 'admin_polish.agent_type_system', fallback: 'System' },
};

/** 'some_source_name' → 'some source name': the last resort for a source this table does not know. */
function spaced(raw: string): string {
    return raw.replace(/[_-]+/g, ' ').trim();
}

/** The source as a reader names it: its area, and what the call was for when that is not the area itself. */
export function sourceName(source: string | null | undefined, t: TranslateFn): string {
    const details = usageSourceDetails(source, t);
    if (!source) return details.label;
    const purpose = SOURCE_PURPOSES[source];
    const areaLabel = areaMeta(details.area, t).label;
    // usageSourceDetails names a source that is the area's own by the area alone.
    if (details.label === areaLabel) return areaLabel;
    if (purpose) return t('admin_polish.source_with_purpose', '{area}: {purpose}', { area: areaLabel, purpose: t(purpose.key, purpose.fallback) });
    if (details.area === 'other') return spaced(source);
    return t('admin_polish.source_with_purpose', '{area}: {purpose}', { area: areaLabel, purpose: spaced(source) });
}

/** The name a call or an agent row goes by: the agent's own name, or (a placeholder or none) its source. */
export function callName(row: { agent_name?: string | null; agent_id?: string | null; source?: string | null }, t: TranslateFn): string {
    const name = row.agent_name?.trim();
    if (name) {
        const placeholder = PLACEHOLDER_AGENT_NAMES[name];
        return placeholder ? t(placeholder.key, placeholder.fallback) : name;
    }
    if (row.source) return sourceName(row.source, t);
    return row.agent_id || t('admin_monitoring.unknown', 'Unknown');
}

/** An agent type as a word; an unknown one is shown as the ledger has it. */
export function agentTypeName(type: string | null | undefined, t: TranslateFn): string {
    const known = type ? AGENT_TYPES[type] : undefined;
    if (known) return t(known.key, known.fallback);
    return type ? spaced(type) : '—';
}
