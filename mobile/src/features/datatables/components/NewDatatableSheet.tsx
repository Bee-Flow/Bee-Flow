/**
 * A new ordinary table — the web's NewDatatableDialog, Simple view: a name, what
 * it is for (the Art. 30 purpose the server refuses blank), who it is for, and
 * optionally a first set of columns drafted from a brief by AI.
 *
 * The technical name follows the name and is shown, not asked for: it is what
 * a Datatable step refers to, and "Invoice date" → invoice_date is what the
 * web does too. Columns typed by hand are added on the Columns tab after
 * creating, where each gets its full sheet; the web's own dialog calls them
 * "optional · can also be added later". Linking a Nextcloud table or a
 * spreadsheet, and the web-service cache kind, stay on the web.
 *
 * Mounted per opening, so the form seeds from the scope as it is then.
 */

import React from 'react';

import { ApiError } from '@/core/api/client';
import { useTranslation, type TranslateFn } from '@/core/i18n';
import { FormSheet, useForm } from '@/shared/patterns';
import { Segmented, Text } from '@/shared/ui';

import { AiDraftField } from './AiDraftField';
import { NameField, nameRules, PurposeField, purposeRules } from './TableFields';
import { useCreateDatatable } from '../hooks/tableMutations';
import { keyFromName } from '../model/columns';
import type { ColumnDraft, CreateScope, Datatable } from '../model/types';

type Placement = 'organisation' | 'personal';

interface Values extends Record<string, unknown> {
    name: string;
    description: string;
    placement: Placement;
    fields: ColumnDraft[];
}

/** What each machine-readable refusal means to a person (NewDatatableDialog.messageFor). */
function createError(t: TranslateFn, err: unknown): unknown {
    const code = err instanceof ApiError ? err.code : undefined;
    const say = (message: string) => new Error(message);
    switch (code) {
        case 'key_taken':
            return say(t('datatables.err_key_taken', 'There is already a table with this key. Pick another one.'));
        case 'no_organisation':
            return say(t('datatables.err_no_org', 'This account is not in an organisation, so it can only make a personal table.'));
        case 'quota_exceeded':
            return say(t('datatables.err_quota', 'You have reached the limit on tables here.'));
        case 'bad_scope':
            return say(t('datatables.err_bad_scope', 'Choose whether the table is for your organisation or for this account.'));
        default:
            return err;
    }
}

export function NewDatatableSheet({
    visible,
    scope,
    canManage,
    onClose,
    onCreated,
}: {
    visible: boolean;
    scope: CreateScope | null;
    canManage: boolean;
    onClose: () => void;
    onCreated: (table: Datatable) => void;
}) {
    const t = useTranslation();
    const create = useCreateDatatable();
    const inOrg = scope?.kind === 'org';
    const form = useForm<Values>({
        initial: { name: '', description: '', placement: inOrg && canManage ? 'organisation' : 'personal', fields: [] },
        validate: {
            name: [
                ...nameRules(t),
                (v: unknown) => (keyFromName(v) ? null : t('mobile.datatables.name_no_key', 'Use at least one letter or digit in the name')),
            ],
            description: purposeRules(t),
        },
        onSubmit: async (v) => {
            const table = await create.mutateAsync({
                ...(inOrg ? { scope: v.placement } : {}),
                name: v.name.trim(),
                key: keyFromName(v.name),
                description: v.description.trim(),
                fields: v.fields,
            });
            if (table) onCreated(table);
        },
    });
    const name = form.field('name');

    return (
        <FormSheet
            visible={visible}
            onClose={onClose}
            title={t('datatables.new_title', 'New datatable')}
            submitLabel={t('datatables.create', 'Create')}
            onSubmit={() => void form.submit()}
            submitting={form.submitting}
            canSubmit={form.canSubmit}
            error={form.submitError ? createError(t, form.submitError) : null}
        >
            <NameField
                binding={name}
                hint={name.value.trim() ? t('mobile.datatables.technical_name_is', 'Technical name: {key}', { key: keyFromName(name.value) }) : undefined}
                testID="new-datatable-name"
            />
            <PurposeField binding={form.field('description')} testID="new-datatable-purpose" />
            {inOrg ? (
                <>
                    <Text variant="label" tone="secondary">
                        {t('datatables.field_audience', 'Who is it for?')}
                    </Text>
                    <Segmented<Placement>
                        fullWidth
                        value={form.values.placement}
                        onChange={(next) => form.set('placement', next)}
                        accessibilityLabel={t('datatables.field_audience', 'Who is it for?')}
                        options={[
                            { value: 'organisation', label: t('datatables.scope_org', 'Your organisation'), disabled: !canManage },
                            { value: 'personal', label: t('datatables.scope_personal', 'This account only') },
                        ]}
                    />
                    <Text variant="caption" tone="tertiary">
                        {!canManage
                            ? t('datatables.scope_org_not_permitted', 'Making one for the whole organisation needs a permission this account does not have — an administrator grants it under Organisation → Roles.')
                            : form.values.placement === 'personal'
                              ? t('datatables.scope_personal_blurb', 'Only this account can see the rows — not colleagues, not administrators. It cannot be shared later.')
                              : t('datatables.scope_org_blurb', 'You decide afterwards who may read or change the rows. Automations your colleagues own can use it.')}
                    </Text>
                </>
            ) : null}
            <AiDraftField
                fields={form.values.fields}
                onDraft={(draft) => {
                    if (!form.values.name.trim()) form.set('name', draft.name);
                    if (!form.values.description.trim()) form.set('description', draft.description);
                    form.set('fields', draft.fields);
                }}
                onClearFields={() => form.set('fields', [])}
            />
        </FormSheet>
    );
}
