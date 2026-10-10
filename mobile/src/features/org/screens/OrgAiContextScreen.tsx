/**
 * Conversation memory (web: org/OrgAiContextEditor.jsx): whether long chats
 * are compacted — off by default, and the copy says what turning it on
 * costs — and the safety limit that applies in both modes.
 *
 * The web's slider (step 5, the server's range) is a Stepper here. The PUT is
 * a full replace, so the two tunables the web does not show either
 * (compactionThreshold, recentWindow) travel back exactly as read.
 */

import React from 'react';

import { describeError } from '@/core/api/errors';
import { useTranslation, type TranslateFn } from '@/core/i18n';
import { Group, NoteRow, SaveBar, Stepper, useToast } from '@/shared/ui';

import { ChoiceGroup, type Choice } from '../components/ChoiceGroup';
import { OrgSettingsFrame } from '../components/OrgSettingsFrame';
import { useSaveOrgAiContext } from '../hooks/sectionMutations';
import { useOrgAiContext } from '../hooks/sectionQueries';
import { useDraft } from '../hooks/useDraft';
import { useOrgContext } from '../hooks/useOrgSections';
import { formatTokens } from '../model/format';
import type { OrgAiContext } from '../model/sectionTypes';

type Mode = 'off' | 'on';

function modeChoices(t: TranslateFn): Choice<Mode>[] {
    return [
        {
            value: 'off',
            label: t('admin.ai_context.off', 'Keep the full conversation (recommended)'),
            description: t(
                'admin.ai_context.off_desc',
                'The assistant sees every earlier message, tool result and attachment for as long as they fit in the model context window. Best answers; higher token use on very long chats.',
            ),
        },
        {
            value: 'on',
            label: t('admin.ai_context.on', 'Summarise older messages'),
            description: t(
                'admin.ai_context.on_desc',
                'Once a chat passes about 16 messages, everything older is replaced by a short summary and long tool results are shortened. Cheaper, but detail from earlier in the conversation is permanently lost to the assistant.',
            ),
        },
    ];
}

/** "Claude Sonnet 5 → ~750,000 tokens", as the web writes each example. */
function budgetExamples(server: OrgAiContext, percent: number, t: TranslateFn): string {
    return server.contextWindowExamples
        .map((ex) =>
            t('mobile.org.ai_context_example', '{model} → ~{tokens} tokens', {
                model: ex.label,
                tokens: formatTokens((ex.contextWindow * percent) / 100),
            }),
        )
        .join('   ·   ');
}

export function OrgAiContextScreen() {
    const t = useTranslation();
    const { toast } = useToast();
    const { orgId, isOrgAdmin } = useOrgContext();
    const allowed = isOrgAdmin && Boolean(orgId);
    const query = useOrgAiContext(allowed ? orgId : null);
    const save = useSaveOrgAiContext(orgId);
    const server = query.data;
    const form = useDraft(
        server ? { compactionEnabled: server.compactionEnabled, contextBudgetPercent: server.contextBudgetPercent } : null,
    );

    const onSave = async () => {
        if (!server || !form.draft) return;
        try {
            await save.mutateAsync({
                compactionEnabled: form.draft.compactionEnabled,
                compactionThreshold: server.compactionThreshold,
                recentWindow: server.recentWindow,
                contextBudgetPercent: form.draft.contextBudgetPercent,
            });
            form.reset();
            toast(t('admin.ai_context.saved', 'Conversation memory settings saved'), 'success');
        } catch (err) {
            toast(describeError(err).message, 'error');
        }
    };

    return (
        <OrgSettingsFrame
            title={t('settings.ai_context', 'Context in long conversations')}
            subtitle={t('mobile.org.ai_context_subtitle', 'How much of a long chat the assistant keeps in view')}
            allowed={allowed}
            query={query}
            dirty={form.dirty}
            footer={<SaveBar dirty={form.dirty} saving={save.isPending} onSave={() => void onSave()} onDiscard={form.reset} />}
        >
            {(data) => {
                const draft = form.draft ?? data;
                const examples = budgetExamples(data, draft.contextBudgetPercent, t);
                return (
                    <>
                        <ChoiceGroup
                            title={t('admin.ai_context.choose', 'Conversation memory')}
                            footer={t(
                                'admin.ai_context.intro',
                                'How much of a long conversation the assistant keeps in view. Applies to chats and agents across the whole organisation and takes effect on the next message.',
                            )}
                            choices={modeChoices(t)}
                            value={draft.compactionEnabled ? 'on' : 'off'}
                            onChange={(mode) => form.set('compactionEnabled', mode === 'on')}
                            disabled={save.isPending}
                        />
                        <Group
                            title={t('admin.ai_context.budget_label', 'Safety limit')}
                            footer={t(
                                'admin.ai_context.safety_note',
                                'A conversation can never overflow the model: once it reaches this share of the context window, the oldest part is summarised automatically.',
                            )}
                        >
                            <Stepper
                                testID="ai-context-budget"
                                label={t('admin.ai_context.budget_label', 'Safety limit')}
                                value={draft.contextBudgetPercent}
                                min={data.contextBudgetRange.min}
                                max={data.contextBudgetRange.max}
                                step={5}
                                format={(v) => `${v}%`}
                                disabled={save.isPending}
                                onChange={(v) => form.set('contextBudgetPercent', v)}
                            />
                            {examples ? <NoteRow>{examples}</NoteRow> : null}
                        </Group>
                    </>
                );
            }}
        </OrgSettingsFrame>
    );
}
