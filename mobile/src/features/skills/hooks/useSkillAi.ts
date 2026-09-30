/**
 * The two AI actions of an open skill, wired to its editor:
 *
 *   - "Improve with AI": the SERVER rewrites and stores, and the editor adopts
 *     the stored row — so the phone and the database cannot show different
 *     skills. A pending keystroke is saved first — `flush` resolves only once
 *     every queued save has landed — because the rewrite is built from what
 *     the server has.
 *   - "Let AI fill it in": a proposal that goes through `patch`, the same
 *     autosave every keystroke goes through, so it is seen before it is kept.
 *     It is applied to the newest draft, so words typed while the model was
 *     thinking are not overwritten by the draft the request started from.
 */

import { ApiError } from '@/core/api/client';
import { describeError } from '@/core/api/errors';
import { useTranslation } from '@/core/i18n';
import { useToast } from '@/shared/ui';

import { useDraftSkill, useImproveSkill } from './mutations';
import type { SkillEditor } from './useSkillEditor';
import { applyProposal } from '../model/aiDraft';
import { draftOf } from '../model/skillModel';

export function useSkillAi(skillId: string, editor: SkillEditor) {
    const t = useTranslation();
    const { toast } = useToast();
    const improve = useImproveSkill(skillId, {
        onSuccess: (skill) => {
            if (skill) editor.adopt(draftOf(skill));
            toast(t('skills_studio.improved', 'Updated with AI.'), 'success');
        },
        onError: (e) => {
            if (e instanceof ApiError && (e.status === 403 || e.code === 'not_editable')) editor.lock();
            toast(describeError(e).message || t('skills_studio.err_improve', 'Could not improve this skill.'), 'error');
        },
    });
    const fill = useDraftSkill({
        onSuccess: (proposal) => {
            if (!proposal) {
                toast(t('skills_studio.err_draft', 'Could not draft this skill.'), 'error');
                return;
            }
            editor.patch((current) => applyProposal(current, proposal), true);
            toast(t('skills_studio.drafted', 'Filled in with AI. Read it through before you rely on it.'), 'success');
        },
        onError: (e) => toast(describeError(e).message || t('skills_studio.err_draft', 'Could not draft this skill.'), 'error'),
    });
    return {
        improving: improve.isPending,
        improve: async () => {
            if (improve.isPending || editor.locked) return;
            await editor.flush();
            improve.mutate();
        },
        drafting: fill.isPending,
        fillIn: (sentence: string) => {
            if (!fill.isPending && !editor.locked && sentence.trim()) fill.mutate(sentence.trim());
        },
    };
}
