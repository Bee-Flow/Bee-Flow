/**
 * The table's own facts: its name and what it is for (PATCH /:id). The
 * purpose is the Art. 30 sentence in the processing record, so it may be
 * corrected but never emptied. The key is not here: it names the physical
 * table and the server refuses to change it.
 */

import React from 'react';

import { useTranslation } from '@/core/i18n';
import { FormSheet, useForm } from '@/shared/patterns';

import { NameField, nameRules, PurposeField, purposeRules } from './TableFields';
import { useUpdateDatatable } from '../hooks/tableMutations';
import type { Datatable } from '../model/types';

interface Values extends Record<string, unknown> {
    name: string;
    description: string;
}

export function DetailsSheet({ table, onClose }: { table: Datatable; onClose: () => void }) {
    const t = useTranslation();
    const update = useUpdateDatatable(table.id);
    const form = useForm<Values>({
        initial: { name: table.name, description: table.description },
        validate: { name: nameRules(t), description: purposeRules(t) },
        onSubmit: async (v) => {
            // Only what changed is sent.
            const patch = {
                ...(v.name.trim() !== table.name ? { name: v.name.trim() } : {}),
                ...(v.description.trim() !== table.description ? { description: v.description.trim() } : {}),
            };
            if (Object.keys(patch).length) await update.mutateAsync(patch);
            onClose();
        },
    });

    return (
        <FormSheet
            visible
            onClose={onClose}
            title={t('datatables.menu_rename', 'Rename table')}
            submitLabel={t('common.save', 'Save')}
            onSubmit={() => void form.submit()}
            submitting={form.submitting}
            canSubmit={form.canSubmit && form.dirty}
            error={form.submitError}
        >
            <NameField binding={form.field('name')} testID="details-name" />
            <PurposeField binding={form.field('description')} testID="details-purpose" />
        </FormSheet>
    );
}
