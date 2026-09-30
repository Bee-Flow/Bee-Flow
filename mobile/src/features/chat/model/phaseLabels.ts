/**
 * What a phase is called on screen — the web's `chat.phase.<stage>` keys,
 * which ActivityIndicator.jsx asks for by the stage's name. Listed as data
 * (`i18nKey` carriers, so the i18n guard checks each one exists), with the
 * web's own fallback for a stage no key names: the stage's words, and the
 * detail after a colon. Pinned against the dictionary by phaseLabels.test.ts.
 */

import type { TranslateFn } from '@/core/i18n';

interface PhaseLabel {
    i18nKey: string;
    en: string;
}

export const PHASE_LABELS: Readonly<Record<string, PhaseLabel>> = {
    building_prompt: { i18nKey: 'chat.phase.building_prompt', en: 'Preparing context…' },
    compacting: { i18nKey: 'chat.phase.compacting', en: 'Compacting conversation…' },
    guardrails: { i18nKey: 'chat.phase.guardrails', en: 'Validating input…' },
    kb_search: { i18nKey: 'chat.phase.kb_search', en: 'Searching knowledge base…' },
    loading_tools: { i18nKey: 'chat.phase.loading_tools', en: 'Loading tools…' },
    memory_lookup: { i18nKey: 'chat.phase.memory_lookup', en: 'Recalling memory…' },
    model_resolved: { i18nKey: 'chat.phase.model_resolved', en: 'Using {detail}' },
    privacy_scan: { i18nKey: 'chat.phase.privacy_scan', en: 'Protecting your data…' },
    privacy_scan_large: {
        i18nKey: 'chat.phase.privacy_scan_large',
        en: 'Protecting a large document — part {detail}, this can take a moment…',
    },
    processed_history: { i18nKey: 'chat.phase.processed_history', en: 'Loading history…' },
    processing_attachments: { i18nKey: 'chat.phase.processing_attachments', en: 'Reading attachment {detail}…' },
    streaming_start: { i18nKey: 'chat.phase.streaming_start', en: 'Thinking…' },
    tier_classify: { i18nKey: 'chat.phase.tier_classify', en: 'Selecting best model…' },
    tool_pre_check: { i18nKey: 'chat.phase.tool_pre_check', en: 'Checking tool plan…' },
};

export function phaseText(stage: string, detail: string | null, t: TranslateFn): string {
    const known = Object.prototype.hasOwnProperty.call(PHASE_LABELS, stage) ? PHASE_LABELS[stage] : undefined;
    if (known) return t(known.i18nKey, known.en, { detail: detail ?? '' });
    const pretty = stage.replace(/_/g, ' ');
    return detail ? `${pretty}: ${detail}` : pretty;
}
