import { useCallback, useMemo, useState } from 'react';
import { toast } from '@/components/shared/Toast';
import { skillsApi } from '@/api/skillsApi';
import { logger } from '@/utils/logger';
import { nOf } from '@/utils/plural';
import type { TranslateFn } from '@/hooks/useTranslation';
import { canDeleteSkill, categoriesOf, cleanableDrafts } from './skillListModel';
import type { Skill, UsageSummaryMap } from './skillModel.types';

/**
 * Studio → Skills, the bookkeeping around the list (2026-11): the category
 * suggestions, who may delete which skill, the delete dialog's subject, and
 * the one-click clean-up of empty drafts.
 */
export interface HousekeepingArgs {
    skills: Skill[];
    summary: UsageSummaryMap | null;
    user: { id?: string; isAdmin?: boolean; role?: string } | null | undefined;
    canManage: boolean;
    openId: string | null;
    open: (id: string | null) => void;
    dropSkill: (id: string) => void;
    loadSummary: () => void;
    t: TranslateFn;
}

export function useSkillHousekeeping({ skills, summary, user, canManage, openId, open, dropSkill, loadSummary, t }: HousekeepingArgs) {
    const categorySuggestions = useMemo(() => categoriesOf(skills), [skills]);
    const mayDelete = useCallback((s: Skill) => canDeleteSkill(s, user, canManage), [user, canManage]);
    const cleanable = useMemo(() => cleanableDrafts(skills, summary, user, canManage), [skills, summary, user, canManage]);
    // The skill whose delete dialog is open (the ⋯ menu on its row or in its header).
    const [deleting, setDeleting] = useState<Skill | null>(null);

    const forget = useCallback((id: string) => {
        dropSkill(id);
        if (id === openId) open(null);
    }, [dropSkill, open, openId]);

    const onDeleted = useCallback((id: string) => {
        forget(id);
        loadSummary();
    }, [forget, loadSummary]);

    /** The header's delete opener for the open skill, or null when this account may not delete it. */
    const requestDeleteOf = (s: Skill | null) => (s && mayDelete(s) ? () => setDeleting(s) : null);

    /**
     * "Remove empty drafts": each one through the ordinary DELETE, WITHOUT
     * confirmBreaking, so a draft something started to use meanwhile is
     * refused by the server's 409 and stays.
     */
    const cleanDrafts = async () => {
        let removed = 0;
        for (const s of cleanable) {
            try {
                await skillsApi.remove(s.id, false);
                forget(s.id);
                removed += 1;
            } catch (err) {
                // In use after all (409), or gone: it stays as it is.
                logger.debug('empty draft not removed', err);
            }
        }
        loadSummary();
        toast.success(nOf(t, 'skillStore.clean_drafts_done', removed, 'Removed {count} empty draft.', 'Removed {count} empty drafts.'));
    };

    const currentUserId = user?.id || null;
    return { currentUserId, categorySuggestions, mayDelete, cleanable, deleting, setDeleting, onDeleted, requestDeleteOf, cleanDrafts };
}
