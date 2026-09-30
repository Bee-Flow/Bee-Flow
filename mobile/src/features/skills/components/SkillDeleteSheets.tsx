/**
 * Deleting a skill: unconfirmed first; a skill an agent or a routine step
 * still uses comes back 409, and the guard sheet shows that list before it
 * confirms. The library and the detail screen share it.
 */

import React, { useState } from 'react';

import { readDeleteGuard, type DeleteGuard } from '@/core/api/deleteGuard';
import { describeError } from '@/core/api/errors';
import { useTranslation } from '@/core/i18n';
import { ConfirmSheet, GuardedDeleteSheet, useToast } from '@/shared/ui';

import { useDeleteSkill } from '../hooks/mutations';
import type { Skill } from '../model/types';

export function SkillDeleteSheets({
    skill,
    onCancel,
    onDeleted,
}: {
    /** The skill whose first confirmation is showing, or null. */
    skill: Skill | null;
    onCancel: () => void;
    onDeleted: (skill: Skill) => void;
}) {
    const t = useTranslation();
    const { toast } = useToast();
    // The skill the server refused to delete, and what it said about it.
    const [guarded, setGuarded] = useState<{ skill: Skill; guard: DeleteGuard } | null>(null);

    const remove = useDeleteSkill({
        onSuccess: (_result, vars) => {
            toast(t('mobile.skills.deleted', 'Skill deleted'), 'success');
            setGuarded(null);
            onDeleted(vars.skill);
        },
        onError: (error, vars) => {
            onCancel();
            const refused = readDeleteGuard(error, 'skill');
            if (refused.blocked) {
                setGuarded({ skill: vars.skill, guard: refused });
                return;
            }
            // Close the sheets, as every guarded delete does: the toast renders
            // under an open sheet, where nobody would see why nothing happened.
            setGuarded(null);
            toast(describeError(error).message, 'error');
        },
    });

    return (
        <>
            <ConfirmSheet
                visible={Boolean(skill)}
                title={t('usage.delete_question', 'Delete “{name}” for good?', { name: skill?.name ?? '' })}
                message={t(
                    'mobile.skills.delete_message',
                    'The skill is removed for everyone it was shared with, and detached from every agent that used it. Chats that already ran with it keep their answers. This cannot be undone.',
                )}
                confirmLabel={t('skills_studio.delete_title', 'Delete skill')}
                busy={remove.isPending}
                onCancel={onCancel}
                onConfirm={() => skill && remove.mutate({ skill, confirmed: false })}
            />
            <GuardedDeleteSheet
                guard={guarded?.guard ?? null}
                name={guarded?.skill.name ?? ''}
                busy={remove.isPending}
                onConfirm={() => guarded && remove.mutate({ skill: guarded.skill, confirmed: true })}
                onCancel={() => setGuarded(null)}
            />
        </>
    );
}
