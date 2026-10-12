/**
 * Deleting a table — the web's DangerZone, armed: what depends on it, and the
 * name typed before the button wakes up, even when nothing does, because a
 * table IS data and its rows go with it.
 *
 * The Used-by answer is already loaded for the tab, so the sheet opens on it
 * rather than on a refusal: `confirmBreaking` goes out only when that answer
 * named something. Should an automation have started using the table in between,
 * the server still refuses (409 `in_use`) and the sheet shows the new list.
 * A linked table is UNLINKED: the copy goes, the source stays.
 */

import { useRouter } from 'expo-router';
import React, { useMemo, useState } from 'react';

import { ApiError } from '@/core/api/client';
import type { DeleteGuard } from '@/core/api/deleteGuard';
import { describeError } from '@/core/api/errors';
import { useTranslation, type TranslateFn } from '@/core/i18n';
import { GuardedDeleteSheet, useToast } from '@/shared/ui';

import { readUsage } from '../api/readers';
import { useDatatableUsage } from '../hooks/queries';
import { useDeleteDatatable } from '../hooks/tableMutations';
import type { Datatable, UsageRow } from '../model/types';
import { siteText } from '../model/words';

function guardOf(t: TranslateFn, usage: readonly UsageRow[] | undefined): DeleteGuard {
    return {
        blocked: true,
        usage: (usage ?? []).map((u) => ({ kind: u.consumerKind, id: u.consumerId, title: u.title, siteLabel: siteText(t, u) })),
        unchecked: [],
        // Not loaded (or failed) is not "nothing uses this": the name is asked for either way.
        readable: usage !== undefined,
    };
}

export function DeleteTableSheet({ table, onClose }: { table: Datatable; onClose: () => void }) {
    const t = useTranslation();
    const router = useRouter();
    const { toast } = useToast();
    const usage = useDatatableUsage(table.id);
    const [refused, setRefused] = useState<UsageRow[] | null>(null);
    const remove = useDeleteDatatable(table.id);
    const known = refused ?? usage.data;
    // One object per answer: the sheet clears the typed name when the answer changes.
    const guard = useMemo(() => guardOf(t, known), [t, known]);

    const confirm = () =>
        remove.mutate((known ?? []).length > 0 || refused !== null, {
            onSuccess: () => {
                onClose();
                toast(t('mobile.datatables.deleted', 'Table deleted'), 'success');
                router.back();
            },
            onError: (err) => {
                if (err instanceof ApiError && err.code === 'in_use') return setRefused(readUsage(err.body));
                onClose();
                toast(describeError(err).message, 'error');
            },
        });

    return <GuardedDeleteSheet guard={guard} name={table.name} requireName busy={remove.isPending} onConfirm={confirm} onCancel={onClose} />;
}
