/**
 * One record of a register (web: the page's drawer): its facts, the actions
 * its status allows, related items and history, an edit sheet that sends
 * only what changed, and — where the register allows it — archive/delete.
 */

import { useRouter } from 'expo-router';
import React, { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { describeError } from '@/core/api/errors';
import { useTranslation } from '@/core/i18n';
import { useConfirm, useUserRefresh } from '@/shared/patterns';
import { EmptyState, ErrorState, GroupedScroll, Icon, IconButton, LoadingState, useToast } from '@/shared/ui';

import { ActionSheets } from './ActionSheets';
import { ComplianceFrame } from './ComplianceFrame';
import { ActionsGroup, HistoryGroup, RelatedGroup } from './RecordExtras';
import { RecordFacts } from './RecordFacts';
import { RecordFormSheet } from './RecordFormSheet';
import { useComplianceWrite } from '../hooks/mutations';
import { useRecordDetail, useRecords } from '../hooks/queries';
import { useActionRunner, type ActionRunner } from '../hooks/useActionRunner';
import type { ComplianceGate } from '../hooks/useComplianceAccess';
import { useFormatter } from '../hooks/useFormatter';
import { initialValues, labelText, patchBody, usesMembers } from '../model/fields';
import type { Formatter, Rec, RecordType } from '../model/types';

function HeaderButtons({ onEdit, onRemove }: { onEdit: (() => void) | null; onRemove: (() => void) | null }) {
    const t = useTranslation();
    return (
        <View style={styles.row}>
            {onEdit ? <IconButton testID="record-edit" accessibilityLabel={t('common.edit', 'Edit')} icon={<Icon name="Pencil" size={18} />} onPress={onEdit} /> : null}
            {onRemove ? <IconButton testID="record-remove" tone="danger" accessibilityLabel={t('common.delete', 'Delete')} icon={<Icon name="Trash2" size={18} />} onPress={onRemove} /> : null}
        </View>
    );
}

function EditSheet({ type, rec, runner, onClose }: { type: RecordType; rec: Rec; runner: ActionRunner; onClose: () => void }) {
    const t = useTranslation();
    const { toast } = useToast();
    const write = useComplianceWrite();
    const edit = type.edit;
    if (!edit) return null;
    return (
        <RecordFormSheet
            title={t('common.edit', 'Edit')}
            submitLabel={t('common.save', 'Save')}
            fields={edit.fields}
            initial={initialValues(edit.fields, rec)}
            rec={rec}
            onClose={onClose}
            onSubmit={async (values) => {
                const patch = patchBody(edit.fields, rec, values);
                if (Object.keys(patch).length === 0) return;
                await write.mutateAsync(edit.request(rec, patch, runner.context()));
                toast(edit.success ? labelText(edit.success, t) : t('common.saved', 'Saved'), 'success');
            }}
        />
    );
}

interface BodyProps {
    type: RecordType;
    rec: Rec | undefined;
    fmt: Formatter;
    runner: ActionRunner;
    list: ReturnType<typeof useRecords>;
    loading: boolean;
}

function DetailBody({ type, rec, fmt, runner, list, loading }: BodyProps) {
    const t = useTranslation();
    const refresh = useUserRefresh(() => list.refetch());
    if (loading) return <LoadingState />;
    if (list.isError) return <ErrorState error={list.error} onRetry={() => void list.refetch()} />;
    if (!rec) return <EmptyState icon={type.icon} title={t('mobile.compliance.not_found', 'This record is no longer in the register.')} />;
    return (
        <GroupedScroll refresh={refresh}>
            <RecordFacts type={type} rec={rec} fmt={fmt} />
            <ActionsGroup type={type} rec={rec} runner={runner} />
            <RelatedGroup type={type} rec={rec} fmt={fmt} runner={runner} />
            <HistoryGroup type={type} rec={rec} fmt={fmt} />
        </GroupedScroll>
    );
}

/** The record: its list row, with the richer single read merged over it when the register has one. */
function useRecord(type: RecordType, id: string, enabled: boolean) {
    const list = useRecords(type, enabled);
    const detail = useRecordDetail(type, id, enabled);
    const row = list.data?.rows.find((r) => type.idOf(r) === id);
    const rec: Rec | undefined = row ? { ...row, ...(detail.data ?? {}) } : undefined;
    return { list, rec, loading: list.isLoading || (Boolean(type.detail) && detail.isLoading) };
}

export function RecordDetail({ type, id, gate }: { type: RecordType; id: string; gate: ComplianceGate }) {
    const t = useTranslation();
    const router = useRouter();
    const { toast } = useToast();
    const confirm = useConfirm();
    const fmt = useFormatter(gate.open && usesMembers(type));
    const { list, rec, loading } = useRecord(type, id, gate.open);
    const write = useComplianceWrite();
    const runner = useActionRunner(list.data?.context ?? null);
    const [editing, setEditing] = useState(false);
    const remove = type.remove;

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

    const buttons = rec ? <HeaderButtons onEdit={type.edit ? () => setEditing(true) : null} onRemove={remove ? () => void onRemove() : null} /> : undefined;
    return (
        <ComplianceFrame title={rec ? type.titleOf(rec, fmt) : labelText(type.noun, t)} subtitle={labelText(type.plural, t)} gate={gate} actions={buttons}>
            <DetailBody type={type} rec={rec} fmt={fmt} runner={runner} list={list} loading={loading} />
            <ActionSheets runner={runner} />
            {editing && rec ? <EditSheet type={type} rec={rec} runner={runner} onClose={() => setEditing(false)} /> : null}
        </ComplianceFrame>
    );
}

const styles = StyleSheet.create({ row: { flexDirection: 'row' } });
