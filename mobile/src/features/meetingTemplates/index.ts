/**
 * Summary templates for Meeting Notes: the list-and-edit screen, the read the
 * Regenerate sheet uses, and the editor and row the organisation's template
 * admin screen (features/orgIntegrations) builds on. Import from
 * '@/features/meetingTemplates'.
 */

export { SummaryTemplatesScreen } from './screens/SummaryTemplatesScreen';
export { TemplateEditorSheet } from './components/TemplateEditorSheet';
export { TemplateRow } from './components/TemplateRow';
export { useOrgTemplates, useSummaryTemplates } from './hooks/queries';
export { sortTemplates } from './model/draft';
export type { SummaryTemplate, SummaryTemplates, TemplateGroup } from './model/types';
