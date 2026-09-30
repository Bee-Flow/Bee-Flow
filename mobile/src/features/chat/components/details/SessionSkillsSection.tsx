/**
 * Chat-local skills.
 *
 * The endpoint only answers usefully for a Standard-tier conversation, and
 * regeneration 400s with "Standard tier is not configured." on an install that
 * has not set one up. Neither is a broken screen, so a 404/403 collapses the
 * section entirely and any other failure to a single sentence.
 */

import React from 'react';

import { ApiError } from '@/core/api/client';
import { describeError } from '@/core/api/errors';
import { useTranslation } from '@/core/i18n';
import type { ChatDetails } from '@/features/chat/hooks/useChatDetails';
import type { SessionSkill } from '@/features/chat/model/types';
import { useConfirm } from '@/shared/patterns';
import { Button, Section, Spinner, Text } from '@/shared/ui';

import { SessionSkillRows } from './SessionSkillRows';

export function SessionSkillsSection({ details }: { details: ChatDetails }) {
    const t = useTranslation();
    const confirm = useConfirm();
    const { skillsQuery, regenerate, dropSkill } = details;
    const error = skillsQuery.error;
    const heading = t('mobile.chat.details.session_skills', 'Session skills');

    // A 404 means this conversation has no session-skill surface at all; a 403
    // means the tier is not on this plan. Both are "nothing to see".
    if (error instanceof ApiError && (error.status === 404 || error.status === 403)) return null;

    if (skillsQuery.isLoading) {
        return (
            <Section title={heading}>
                <Spinner />
            </Section>
        );
    }

    if (error) {
        return (
            <Section title={heading}>
                <Text variant="caption" tone="tertiary">
                    {describeError(error).message}
                </Text>
            </Section>
        );
    }

    const askToRemove = async (skill: SessionSkill) => {
        const ok = await confirm({
            title: t('mobile.chat.details.remove_skill_title', 'Remove “{name}”?', { name: skill.name }),
            message: t('mobile.chat.details.remove_skill_message', 'The step is dropped from this conversation only.'),
            confirmLabel: t('common.delete', 'Delete'),
        });
        if (ok) dropSkill.mutate(skill.id);
    };

    return (
        <Section
            title={heading}
            subtitle={t('mobile.chat.details.session_skills_subtitle', 'The steps Bee Flow planned for this conversation. They live in this chat only.')}
        >
            <SessionSkillRows
                skills={skillsQuery.data?.skills ?? []}
                activated={new Set(skillsQuery.data?.activatedSkillIds ?? [])}
                onDelete={(skill) => void askToRemove(skill)}
            />
            <Button
                label={t('mobile.chat.details.replan', 'Re-plan the steps')}
                variant="secondary"
                loading={regenerate.isPending}
                disabled={regenerate.isPending}
                onPress={() => regenerate.mutate()}
            />
        </Section>
    );
}
