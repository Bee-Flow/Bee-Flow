/**
 * Make the page public, or change how: who may open the address, until
 * when, and which columns of the tables it shows may leave the building —
 * the web's Audience panel, public row (WebpageAudiencePanel.jsx). The rules
 * that keep a live link alive are in model/publicChoice.ts.
 */

import React, { useState } from 'react';

import { useTranslation } from '@/core/i18n';
import { FormSheet } from '@/shared/patterns';
import { FilterPills, OptionRow, Section, TextField, ToggleRow, useToast } from '@/shared/ui';

import { useSetPublic } from '../hooks/audienceMutations';
import type { ColumnGateTable, PublicAccessMode, WebpageAudience } from '../model/audienceTypes';
import {
    draftProblem,
    initialDraft,
    toChoice,
    toggleColumn,
    type ExpiryChoice,
    type PublicDraft,
} from '../model/publicChoice';

function ColumnGate({
    tables,
    draft,
    onChange,
}: {
    tables: ColumnGateTable[];
    draft: PublicDraft;
    onChange: (next: PublicDraft) => void;
}) {
    const t = useTranslation();
    if (!tables.length) return null;
    return (
        <Section
            title={t('mobile.webpages.public.columns', 'Columns shown publicly')}
            subtitle={t('mobile.webpages.public.columns_hint', 'A column left off is never sent to visitors')}
        >
            {tables.map((table) =>
                table.columns.map((column) => (
                    <ToggleRow
                        key={`${table.datatableId}:${column}`}
                        label={column}
                        description={table.label ?? table.datatableId}
                        value={(draft.columns[table.datatableId] ?? []).includes(column)}
                        onValueChange={() => onChange(toggleColumn(draft, table.datatableId, column))}
                    />
                )),
            )}
        </Section>
    );
}

function AccessFields({
    draft,
    hasPassword,
    onChange,
}: {
    draft: PublicDraft;
    hasPassword: boolean;
    onChange: (next: PublicDraft) => void;
}) {
    const t = useTranslation();
    const modes: { value: PublicAccessMode; label: string; description: string }[] = [
        {
            value: 'unlisted',
            label: t('mobile.webpages.public.unlisted', 'Anyone with the address'),
            description: t('mobile.webpages.public.unlisted_hint', 'Opens straight away'),
        },
        {
            value: 'password',
            label: t('mobile.webpages.public.password', 'With a password'),
            description: t('mobile.webpages.public.password_hint', 'Visitors type it first'),
        },
        {
            value: 'email',
            label: t('mobile.webpages.public.email', 'Only these e-mail addresses'),
            description: t('mobile.webpages.public.email_hint', 'Visitors confirm their address first'),
        },
    ];
    return (
        <>
            {modes.map((mode) => (
                <OptionRow
                    key={mode.value}
                    label={mode.label}
                    description={mode.description}
                    selected={draft.accessMode === mode.value}
                    onPress={() => onChange({ ...draft, accessMode: mode.value })}
                />
            ))}
            {draft.accessMode === 'password' ? (
                <TextField
                    label={t('mobile.webpages.public.password_field', 'Password')}
                    hint={
                        hasPassword
                            ? t(
                                  'mobile.webpages.public.password_keep',
                                  'Leave empty to keep the current password. A new one gives the page a new address.',
                              )
                            : t('mobile.webpages.public.password_min', 'At least six characters.')
                    }
                    value={draft.password}
                    onChangeText={(password) => onChange({ ...draft, password })}
                    secure
                />
            ) : null}
            {draft.accessMode === 'email' ? (
                <TextField
                    label={t('mobile.webpages.public.emails', 'Allowed addresses')}
                    hint={t('mobile.webpages.public.emails_hint', 'One per line, or separated by commas')}
                    value={draft.emails}
                    onChangeText={(emails) => onChange({ ...draft, emails })}
                    autoCapitalize="none"
                    keyboardType="email-address"
                    multiline
                />
            ) : null}
        </>
    );
}

export function PublicSheet({
    pageId,
    audience,
    visible,
    onClose,
}: {
    pageId: string;
    audience: WebpageAudience;
    visible: boolean;
    onClose: () => void;
}) {
    const t = useTranslation();
    const { toast } = useToast();
    const [draft, setDraft] = useState(() => initialDraft(audience));
    const save = useSetPublic(pageId, {
        onSuccess: () => {
            toast(t('mobile.webpages.public.saved', 'The page is public'), 'success');
            onClose();
        },
    });
    const problem = draftProblem(draft, audience.public.hasPassword && audience.public.accessMode === 'password');
    const expiries: { value: ExpiryChoice; label: string }[] = [
        ...(audience.public.expiresAt
            ? [{ value: 'keep' as const, label: t('mobile.webpages.public.expiry_keep', 'Keep current') }]
            : []),
        { value: 'never', label: t('mobile.webpages.public.expiry_never', 'Never') },
        { value: '7', label: t('mobile.webpages.public.expiry_7', '7 days') },
        { value: '30', label: t('mobile.webpages.public.expiry_30', '30 days') },
    ];

    return (
        <FormSheet
            visible={visible}
            onClose={onClose}
            title={t('mobile.webpages.public.title', 'Public address')}
            subtitle={t(
                'mobile.webpages.public.subtitle',
                'A snapshot of the page, without its JavaScript, at its own address',
            )}
            submitLabel={
                audience.public.on
                    ? t('mobile.webpages.public.update', 'Update')
                    : t('mobile.webpages.public.make', 'Make public')
            }
            onSubmit={() => save.mutate(toChoice(draft))}
            submitting={save.isPending}
            canSubmit={problem === null}
            error={save.isError ? save.error : undefined}
        >
            <AccessFields draft={draft} hasPassword={audience.public.hasPassword} onChange={setDraft} />
            <Section title={t('mobile.webpages.public.expiry', 'Stops working')}>
                <FilterPills
                    value={draft.expiry}
                    onChange={(expiry) => setDraft({ ...draft, expiry })}
                    options={expiries}
                />
            </Section>
            <ColumnGate tables={audience.columnGate.tables} draft={draft} onChange={setDraft} />
        </FormSheet>
    );
}
