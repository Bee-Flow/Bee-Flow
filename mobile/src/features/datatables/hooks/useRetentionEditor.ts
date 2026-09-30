/**
 * The retention editor's state (the web's RetentionPanel): the window being
 * chosen, the column it counts from, a typed number of days, and the sentence
 * the last save left behind.
 *
 * A preset, "Never" and a new column save at once; a typed number saves on
 * Apply. Every save sends the window WITH its column (model/retention
 * retentionPatch) — a preset with no column to count from is refused here,
 * in words, before the server has to. The draft follows the server: when the
 * table's window or column changes (this save, or somebody else's), it is
 * seeded again, while the saved/failed sentence stays.
 */

import { useState } from 'react';

import { ApiError } from '@/core/api/client';
import { describeError } from '@/core/api/errors';
import { useTranslation, type TranslateFn } from '@/core/i18n';

import { useUpdateDatatable } from './tableMutations';
import {
    customDays,
    initialRetentionField,
    isPresetDays,
    retentionChoice,
    retentionFieldLabel,
    retentionPatch,
    type RetentionChoice,
} from '../model/retention';
import type { Column, Datatable } from '../model/types';

interface Draft {
    days: number | null;
    field: string;
    custom: boolean;
    text: string;
}

export interface RetentionFeedback {
    tone: 'note' | 'error';
    text: string;
}

function seed(table: Datatable, columns: readonly Column[]): Draft {
    const days = table.retentionDays || null;
    const custom = !!days && !isPresetDays(days);
    return { days, field: initialRetentionField(table, columns), custom, text: custom ? String(days) : '' };
}

const fieldRequired = (t: TranslateFn) => t('datatables.retention_field_required', 'Pick the date column the age is measured from.');

function errorText(t: TranslateFn, err: unknown): string {
    if (err instanceof ApiError && err.code === 'retention_field_required') return fieldRequired(t);
    return describeError(err).message || t('datatables.err_retention', 'Could not change the retention window');
}

function savedText(t: TranslateFn, columns: readonly Column[], days: number | null, field: string): string {
    return days === null
        ? t('datatables.retention_saved_off', 'Rows are kept until something deletes them.')
        : t('datatables.retention_saved', 'Saved. Rows are deleted {n} days after their {field}.', { n: days, field: retentionFieldLabel(t, columns, field) });
}

export function useRetentionEditor(table: Datatable, columns: readonly Column[]) {
    const t = useTranslation();
    const update = useUpdateDatatable(table.id);
    const [draft, setDraft] = useState<Draft>(() => seed(table, columns));
    const [feedback, setFeedback] = useState<RetentionFeedback | null>(null);
    const truth = `${table.id}:${table.retentionDays ?? ''}:${table.retentionField ?? ''}`;
    const [seen, setSeen] = useState(truth);
    if (seen !== truth) {
        setSeen(truth);
        setDraft(seed(table, columns));
    }

    const save = (days: number | null, field: string) => {
        setFeedback(null);
        update.mutate(retentionPatch(days, field), {
            onSuccess: () => setFeedback({ tone: 'note', text: savedText(t, columns, days, field) }),
            onError: (err) => {
                setFeedback({ tone: 'error', text: errorText(t, err) });
                // A refused preset must not stay lit as if it held; a typed number stays to be corrected.
                setDraft((d) => (d.custom ? d : seed(table, columns)));
            },
        });
    };
    /** A window is never sent without its column — say so instead. */
    const saveWindow = (days: number) => (draft.field ? save(days, draft.field) : setFeedback({ tone: 'error', text: fieldRequired(t) }));

    const choose = (value: RetentionChoice) => {
        if (value !== 'custom' && value === retentionChoice(draft.days, draft.custom)) return;
        if (value === 'custom') {
            setDraft((d) => ({ ...d, custom: true, text: d.text || (d.days ? String(d.days) : '') }));
            return;
        }
        const days = value === 'off' ? null : Number(value);
        setDraft((d) => ({ ...d, custom: false, days: days === null || d.field ? days : d.days }));
        if (days === null) save(null, draft.field);
        else saveWindow(days);
    };
    const pickField = (field: string) => {
        if (field === draft.field) return;
        setDraft((d) => ({ ...d, field }));
        if (table.retentionDays) save(table.retentionDays, field);
    };
    const typed = customDays(draft.text);

    return {
        busy: update.isPending,
        choice: retentionChoice(draft.days, draft.custom),
        custom: draft.custom,
        text: draft.text,
        field: draft.field,
        feedback,
        /** Apply is offered only for a whole number in range, with a column to count from. */
        canApply: typed !== null && draft.field !== '' && !update.isPending,
        choose,
        pickField,
        setText: (text: string) => setDraft((d) => ({ ...d, text })),
        apply: () => {
            if (typed === null) return;
            setDraft((d) => ({ ...d, days: typed }));
            saveWindow(typed);
        },
    };
}

export type RetentionEditor = ReturnType<typeof useRetentionEditor>;
