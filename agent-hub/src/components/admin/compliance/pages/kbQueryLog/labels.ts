import type { StatusTable } from '../audits/auditForms';

/** How the closed vocabularies of the query log read. Tables of { tone, key, en }, read through labelOf / toneOf. */
export const KQL_OUTCOME: StatusTable = Object.freeze({
    answered: Object.freeze({ tone: 'success', key: 'compliance.kql_outcome_answered', en: 'Answered' }),
    no_results: Object.freeze({ tone: 'warning', key: 'compliance.kql_outcome_no_results', en: 'No results' }),
    error: Object.freeze({ tone: 'error', key: 'compliance.kql_outcome_error', en: 'Error' }),
});

export const KQL_STATUS: StatusTable = Object.freeze({
    to_review: Object.freeze({ tone: 'warning', key: 'compliance.kql_status_to_review', en: 'To review' }),
    reviewed: Object.freeze({ tone: 'success', key: 'compliance.kql_status_reviewed', en: 'Reviewed' }),
    needs_addition: Object.freeze({ tone: 'neutral', key: 'compliance.kql_status_needs_addition', en: 'Needs addition' }),
});

export const KQL_CHANNEL: StatusTable = Object.freeze({
    agent_chat: Object.freeze({ key: 'compliance.kql_channel_agent_chat', en: 'Agent chat' }),
    agent_chat_sync: Object.freeze({ key: 'compliance.kql_channel_agent_chat_sync', en: 'Agent chat (API)' }),
    direct_chat: Object.freeze({ key: 'compliance.kql_channel_direct_chat', en: 'Chat' }),
    template_chat: Object.freeze({ key: 'compliance.kql_channel_template_chat', en: 'Template chat' }),
    notebook: Object.freeze({ key: 'compliance.kql_channel_notebook', en: 'Notebook' }),
    webpage: Object.freeze({ key: 'compliance.kql_channel_webpage', en: 'AI webpage' }),
    project_assistant: Object.freeze({ key: 'compliance.kql_channel_project_assistant', en: 'Project assistant' }),
    automation_ai_step: Object.freeze({ key: 'compliance.kql_channel_automation_ai_step', en: 'Automation AI step' }),
    studio_kb_query: Object.freeze({ key: 'compliance.kql_channel_studio_kb_query', en: 'App: knowledge query' }),
    studio_ai_generate: Object.freeze({ key: 'compliance.kql_channel_studio_ai_generate', en: 'App: AI generate' }),
    studio_ai_extract: Object.freeze({ key: 'compliance.kql_channel_studio_ai_extract', en: 'App: AI extract' }),
    studio_ai_chat: Object.freeze({ key: 'compliance.kql_channel_studio_ai_chat', en: 'App: AI chat' }),
    support: Object.freeze({ key: 'compliance.kql_channel_support', en: 'Support' }),
    skill: Object.freeze({ key: 'compliance.kql_channel_skill', en: 'Skill' }),
    kb_test: Object.freeze({ key: 'compliance.kql_channel_kb_test', en: 'Test search' }),
    api_search: Object.freeze({ key: 'compliance.kql_channel_api_search', en: 'Search API' }),
});
