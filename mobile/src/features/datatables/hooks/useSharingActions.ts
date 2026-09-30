/**
 * The sharing decisions, on the web's terms (DatatableSharing.jsx):
 *
 *   - WIDENING ASKS, NARROWING DOES NOT. Private → groups, private →
 *     organisation, groups → organisation and opening write access each hand
 *     real people access they did not have a second ago, so each is confirmed
 *     with WHO and WHAT. Taking access away is one tap.
 *   - "Specific groups" sends nothing until a group is picked: an empty
 *     `sharedGroups` on a published table means the WHOLE organisation, so
 *     publishing on the tap would be the opposite of the option's label. And
 *     un-picking the last group unpublishes, rather than widening.
 *   - 402 / `capability_required` is the paid boundary, said as such.
 */

import { useState } from 'react';

import { ApiError } from '@/core/api/client';
import { useTranslation } from '@/core/i18n';
import { useConfirm } from '@/shared/patterns';

import { useSetSharing } from './sharingMutations';
import { audienceOf, widens, type AudienceId } from '../model/access';
import type { Datatable, SharingDescriptor } from '../model/types';

export function isPaywall(err: unknown): boolean {
    return err instanceof ApiError && (err.status === 402 || err.code === 'capability_required');
}

export function useSharingActions(table: Datatable, groupNames: (ids: readonly string[]) => string) {
    const t = useTranslation();
    const confirm = useConfirm();
    const mutation = useSetSharing(table.id);
    const [paywalled, setPaywalled] = useState(false);
    const audience = audienceOf(table);
    const andWrite = table.writeMode === 'audience' ? t('datatables.and_write', ', and to add, change and delete them') : '';

    const send = (descriptor: SharingDescriptor) => {
        setPaywalled(false);
        mutation.mutate(descriptor, { onError: (err) => setPaywalled(isPaywall(err)) });
    };
    const askThenSend = async (message: string, descriptor: SharingDescriptor) => {
        const ok = await confirm({
            title: t('datatables.share_confirm_title', 'Give more people access?'),
            message,
            confirmLabel: t('datatables.share_confirm_yes', 'Share it'),
            tone: 'primary',
        });
        if (ok) send(descriptor);
    };

    /** 'groups' is not handled here: the picker's answer is (applyGroups). */
    const chooseAudience = (next: Exclude<AudienceId, 'groups'>) => {
        if (next === audience) return;
        if (next === 'private') return send({ audience: 'private' });
        void askThenSend(
            t('datatables.confirm_org', 'Everyone in your organisation will be able to read every row of “{name}”{write}.', { name: table.name, write: andWrite }),
            { audience: 'organisation' },
        );
    };

    const applyGroups = (ids: string[]) => {
        if (!ids.length) return send({ audience: 'private' });
        const descriptor: SharingDescriptor = { audience: 'groups', sharedGroups: ids };
        if (!widens(audience, 'groups')) return send(descriptor);
        void askThenSend(
            t('datatables.confirm_groups', 'Members of {groups} will be able to read every row of “{name}”{write}.', { groups: groupNames(ids), name: table.name, write: andWrite }),
            descriptor,
        );
    };

    const setWriteOpen = (open: boolean, readers: string) => {
        if (!open) return send({ writeMode: 'grants' });
        void askThenSend(
            t('datatables.confirm_write', '{who} will be able to add, change and delete rows, not just read them.', { who: readers }),
            { writeMode: 'audience' },
        );
    };

    return {
        audience,
        busy: mutation.isPending,
        error: mutation.error && !paywalled ? mutation.error : null,
        paywalled,
        setPaywalled,
        chooseAudience,
        applyGroups,
        setWriteOpen,
    };
}
