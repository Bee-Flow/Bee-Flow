/**
 * A new skill: a name, or one sentence and "Let AI fill it in".
 *
 * The AI draft (POST /api/skills/ai/draft) is a PROPOSAL — nothing is stored
 * until "Create skill". It prefills the name and shows what the model wrote
 * (description and the steps / rules / examples count); the whole proposal is
 * then created in one POST, structure included, and the skill opens on its
 * Method tab to be read through.
 */

import React, { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { describeError } from '@/core/api/errors';
import { useTranslation } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { FormSheet } from '@/shared/patterns';
import { Text } from '@/shared/ui';

import { FillInCard } from './FillInCard';
import { NameIconFields } from './NameIconFields';
import { useDraftSkill, type NewSkill } from '../hooks/mutations';
import { applyProposal } from '../model/aiDraft';
import { buildSavePayload, draftOf, metaLine } from '../model/skillModel';
import type { SkillDraft } from '../model/types';

const makeStyles = (theme: Theme) =>
    StyleSheet.create({
        preview: { gap: theme.spacing.xs },
    });

export function NewSkillSheet({
    visible,
    busy,
    error,
    onClose,
    onCreate,
}: {
    visible: boolean;
    busy: boolean;
    error: unknown;
    onClose: () => void;
    onCreate: (skill: NewSkill) => void;
}) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    const [draft, setDraft] = useState<SkillDraft>(() => ({ ...draftOf({}), icon: '' }));
    const [drafted, setDrafted] = useState(false);
    const aiDraft = useDraftSkill({
        onSuccess: (proposal) => {
            if (!proposal) return;
            setDraft((d) => applyProposal(d, proposal));
            setDrafted(true);
        },
    });
    const draftFailed = aiDraft.error || (aiDraft.isSuccess && !aiDraft.data);
    const set = (next: Partial<SkillDraft>) => setDraft((d) => ({ ...d, ...next }));

    return (
        <FormSheet
            visible={visible}
            onClose={onClose}
            title={t('mobile.skills.new', 'New skill')}
            subtitle={t('mobile.skills.new_subtitle', 'A reusable set of instructions an agent follows when a task matches')}
            submitLabel={t('mobile.skills.create', 'Create skill')}
            submitting={busy}
            canSubmit={draft.name.trim().length > 0 && !aiDraft.isPending}
            error={error}
            onSubmit={() => onCreate({ ...buildSavePayload(draft), icon: draft.icon || '⚡', name: draft.name.trim() })}
        >
            <NameIconFields
                name={draft.name}
                icon={draft.icon}
                onName={(name) => set({ name })}
                onIcon={(icon) => set({ icon })}
            />
            <FillInCard drafting={aiDraft.isPending} onFillIn={(sentence) => aiDraft.mutate(sentence)} />
            {draftFailed ? (
                <Text variant="caption" tone="error">
                    {aiDraft.error ? describeError(aiDraft.error).message : t('skills_studio.err_draft', 'Could not draft this skill.')}
                </Text>
            ) : null}
            {drafted ? (
                <View style={styles.preview} testID="skill-draft-preview">
                    <Text variant="caption" tone="secondary">
                        {draft.description}
                    </Text>
                    <Text variant="label" tone="tertiary">
                        {metaLine(draft, t)}
                    </Text>
                    <Text variant="caption" tone="warning">
                        {t('skills_studio.drafted', 'Filled in with AI. Read it through before you rely on it.')}
                    </Text>
                </View>
            ) : null}
        </FormSheet>
    );
}
