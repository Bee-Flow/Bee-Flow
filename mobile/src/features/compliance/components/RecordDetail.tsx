/**
 * One record of a register (web: the page's drawer): its facts, the actions
 * its status allows, related items and history, an edit sheet that sends
 * only what changed, and — where the register allows it — archive/delete.
 * A register's own panels sit above the facts and after the history. When
 * the register's richer single read fails, the page says so with a retry and
 * offers no edit, actions or related items: an edit typed over a falsely
 * empty field would overwrite the real draft.
 */

import { useRouter } from 'expo-router';
import React, { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { describeError } from '@/core/api/errors';
import { useTranslation, type TranslateFn } from '@/core/i18n';
import { useConfirm, useUserRefresh } from '@/shared/patterns';
import { EmptyState, ErrorState, Group, GroupedScroll, Icon, IconButton, LoadingState, NoteRow, SettingRow, useToast, type IconName } from '@/shared/ui';

import { ActionSheets } from './ActionSheets';
import { ComplianceFrame } from './ComplianceFrame';
import { ActionsGroup, HistoryGroup, RelatedGroup } from './RecordExtras';
import { RecordFacts } from './RecordFacts';
import { RecordFormSheet } from './RecordFormSheet';
import type { RecordPanels } from './recordPanels';
import { useComplianceWrite } from '../hooks/mutations';
import { useRecordDetail, useRecords } from '../hooks/queries';
import { actionError, useActionRunner, type ActionRunner } from '../hooks/useActionRunner';
import type { ComplianceGate } from '../hooks/useComplianceAccess';
import { useFormatter } from '../hooks/useFormatter';
import { initialValues, labelText, patchBody, usesMembers } from '../model/fields';
import type { Formatter, Rec, RecordType } from '../model/types';

interface HeaderButtonsProps {
    onEdit: (() => void) | null;
    onRemove: (() => void) | null;
    removeLabel: string;
    removeIcon: IconName;
}

function HeaderButtons({ onEdit, onRemove, removeLabel, removeIcon }: HeaderButtonsProps) {
    const t = useTranslation();
    return (
        <View style={styles.row}>
            {onEdit ? <IconButton testID="record-edit" accessibilityLabel={t('common.edit', 'Edit')} icon={<Icon name="Pencil" size={18} />} onPress={onEdit} /> : null}
            {onRemove ? <IconButton testID="record-remove" tone="danger" accessibilityLabel={removeLabel} icon={<Icon name={removeIcon} size={18} />} onPress={onRemove} /> : null}
        </View>
    );
}

function EditSheet({ type, rec, runner, onClose }: { type: RecordType; rec: Rec; runner: ActionRunner; onClose: () => void }) {
    const t = useTranslation();
    const { toast } = useToast();
    const write = useComplianceWrite();
    const edit = type.edit;
    if (!edit) return null;
    const validate = edit.validate;
    return (
        <RecordFormSheet
            title={t('common.edit', 'Edit')}
            submitLabel={t('common.save', 'Save')}
            fields={edit.fields}
            initial={initialValues(edit.fields, rec)}
            rec={rec}
            validate={validate ? (values) => validate(values, rec, t) : undefined}
            onClose={onClose}
            onSubmit={async (values) => {
                const patch = patchBody(edit.fields, rec, values);
                if (Object.keys(patch).length === 0) return;
                try {
                    await write.mutateAsync(edit.request(rec, patch, runner.context()));
                } catch (err) {
                    throw actionError(edit, err, t);
                }
                toast(edit.success ? labelText(edit.success, t) : t('common.saved', 'Saved'), 'success');
            }}
        />
    );
}

type Detail = ReturnType<typeof useRecordDetail>;

interface BodyProps {
    type: RecordType;
    rec: Rec | undefined;
    fmt: Formatter;
    runner: ActionRunner;
    list: ReturnType<typeof useRecords>;
    detail: Detail;
    loading: boolean;
    panels?: RecordPanels;
}

/** The register's single read failed: say so, offer a retry, offer nothing to change. */
function DetailFailed({ type, detail }: { type: RecordType; detail: Detail }) {
    const t = useTranslation();
    const text = type.detail?.errorText ? labelText(type.detail.errorText, t) : t('common.error', 'Error');
    return (
        <Group>
            <NoteRow>{text}</NoteRow>
            <SettingRow testID="record-detail-retry" label={t('mobile.error.retry', 'Try again')} icon={<Icon name="RefreshCw" size={18} />} onPress={() => void detail.refetch()} />
        </Group>
    );
}

function DetailBody({ type, rec, fmt, runner, list, detail, loading, panels }: BodyProps) {
    const t = useTranslation();
    const refresh = useUserRefresh(() => Promise.all([list.refetch(), type.detail ? detail.refetch() : null]));
    if (loading) return <LoadingState />;
    if (list.isError) return <ErrorState error={list.error} onRetry={() => void list.refetch()} />;
    if (!rec) return <EmptyState icon={type.icon} title={t('mobile.compliance.not_found', 'This record is no longer in the register.')} />;
    const failed = detailFailed(type, detail);
    const runAction = (id: string) => {
        const action = type.actions?.find((a) => a.id === id);
        if (action) void runner.run(action, rec);
    };
    const Top = failed ? undefined : panels?.DetailTop;
    const Bottom = failed ? undefined : panels?.DetailBottom;
    return (
        <GroupedScroll refresh={refresh}>
            {Top ? <Top type={type} rec={rec} fmt={fmt} runAction={runAction} /> : null}
            <RecordFacts type={type} rec={rec} fmt={fmt} />
            {failed ? <DetailFailed type={type} detail={detail} /> : null}
            {failed ? null : <ActionsGroup type={type} rec={rec} runner={runner} />}
            {failed ? null : <RelatedGroup type={type} rec={rec} fmt={fmt} runner={runner} />}
            <HistoryGroup type={type} rec={rec} fmt={fmt} />
            {Bottom ? <Bottom type={type} rec={rec} fmt={fmt} runAction={runAction} /> : null}
        </GroupedScroll>
    );
}

const detailFailed = (type: RecordType, detail: Detail) => Boolean(type.detail) && detail.isError && !detail.data;

/** The header's words and which buttons it offers. */
function chromeOf(type: RecordType, rec: Rec | undefined, fmt: Formatter, failed: boolean, t: TranslateFn) {
    const edit = type.edit;
    const canEdit = Boolean(rec && edit && (!edit.when || edit.when(rec)) && !failed);
    const remove = type.remove;
    return {
        canEdit,
        title: rec ? type.titleOf(rec, fmt) : labelText(type.noun, t),
        subtitle: (rec && type.subtitleOf?.(rec, fmt)) || labelText(type.plural, t),
        removeLabel: remove?.label ? labelText(remove.label, t) : t('common.delete', 'Delete'),
        removeIcon: remove?.icon ?? ('Trash2' as IconName),
    };
}

/** The record: its list row, with the richer single read merged over it when the register has one. */
function useRecord(type: RecordType, id: string, enabled: boolean) {
    const list = useRecords(type, enabled);
    const detail = useRecordDetail(type, id, enabled);
    const row = list.data?.rows.find((r) => type.idOf(r) === id);
    const rec: Rec | undefined = row ? { ...row, ...(detail.data ?? {}) } : undefined;
    return { list, detail, rec, loading: list.isLoading || (Boolean(type.detail) && detail.isLoading) };
}

export function RecordDetail({ type, id, gate, panels }: { type: RecordType; id: string; gate: ComplianceGate; panels?: RecordPanels }) {
    const t = useTranslation();
    const router = useRouter();
    const { toast } = useToast();
    const confirm = useConfirm();
    const fmt = useFormatter(gate.open && usesMembers(type));
    const { list, detail, rec, loading } = useRecord(type, id, gate.open);
    const write = useComplianceWrite();
    const runner = useActionRunner(list.data?.context ?? null, (uid) => (fmt.user(uid) === '—' ? null : fmt.user(uid)));
    const [editing, setEditing] = useState(false);
    const remove = type.remove;
    const chrome = chromeOf(type, rec, fmt, detailFailed(type, detail), t);

    const onRemove = async () => {
        if (!rec || !remove) return;
        const ok = await confirm({ title: labelText(remove.confirm, t), message: type.titleOf(rec, fmt), confirmLabel: labelText(remove.confirm, t) });
        if (!ok) return;
        try {
            await write.mutateAsync(remove.request(rec));
            router.back();
        } catch (err) {
            toast(describeError(err).message, 'error');
        }
    };

    const buttons = rec ? (
        <HeaderButtons
            onEdit={chrome.canEdit ? () => setEditing(true) : null}
            onRemove={remove ? () => void onRemove() : null}
            removeLabel={chrome.removeLabel}
            removeIcon={chrome.removeIcon}
        />
    ) : undefined;
    return (
        <ComplianceFrame title={chrome.title} subtitle={chrome.subtitle} gate={gate} actions={buttons}>
            <DetailBody type={type} rec={rec} fmt={fmt} runner={runner} list={list} detail={detail} loading={loading} panels={panels} />
            <ActionSheets runner={runner} />
            {editing && rec ? <EditSheet type={type} rec={rec} runner={runner} onClose={() => setEditing(false)} /> : null}
        </ComplianceFrame>
    );
}

const styles = StyleSheet.create({ row: { flexDirection: 'row' } });
