/**
 * A register as a searchable list (web: each page's DataTable in its phone
 * card layout): the page's intro, its list buttons (seed the templates,
 * download the register), a create button, and a row per record that opens
 * its detail.
 */

import React, { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { describeError } from '@/core/api/errors';
import { useTranslation } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { QueryList } from '@/shared/patterns';
import { Button, Text, useToast } from '@/shared/ui';

import { RecordFormSheet } from './RecordFormSheet';
import { RecordContext, renderRecord } from './RecordRow';
import { shareDownload } from '../api/endpoints';
import { useComplianceWrite } from '../hooks/mutations';
import { useRecords } from '../hooks/queries';
import { useFormatter } from '../hooks/useFormatter';
import { initialValues, labelText, matchesSearch, usesMembers } from '../model/fields';
import type { ListActionSpec, Rec, RecordType } from '../model/types';

function ListHeader({ type, actions, onCreate, onAction, busy }: {
    type: RecordType;
    actions: readonly ListActionSpec[];
    onCreate: (() => void) | null;
    onAction: (action: ListActionSpec) => void;
    busy: string | null;
}) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    return (
        <View style={styles.header}>
            {type.intro ? (
                <Text variant="caption" tone="secondary">
                    {labelText(type.intro, t)}
                </Text>
            ) : null}
            <View style={styles.buttons}>
                {onCreate && type.create ? (
                    <Button testID={`create-${type.id}`} size="sm" iconName="Plus" label={labelText(type.create.label, t)} onPress={onCreate} />
                ) : null}
                {actions.map((a) => (
                    <Button
                        key={a.id}
                        testID={`list-action-${a.id}`}
                        size="sm"
                        variant="secondary"
                        iconName={a.icon}
                        loading={busy === a.id}
                        label={labelText(a.label, t)}
                        onPress={() => onAction(a)}
                    />
                ))}
            </View>
        </View>
    );
}

export function RecordList({ type }: { type: RecordType }) {
    const t = useTranslation();
    const { toast } = useToast();
    const fmt = useFormatter(usesMembers(type));
    const query = useRecords(type, true);
    const write = useComplianceWrite();
    const [creating, setCreating] = useState(false);
    const [busy, setBusy] = useState<string | null>(null);
    const set = query.data;
    const actions = (type.listActions ?? []).filter((a) => !a.when || (set ? a.when(set) : false));

    const onAction = async (action: ListActionSpec) => {
        setBusy(action.id);
        try {
            if (action.download) await shareDownload(action.download);
            else if (action.request) {
                await write.mutateAsync(action.request());
                toast(action.success ? labelText(action.success, t) : t('common.saved', 'Saved'), 'success');
            }
        } catch (err) {
            toast(describeError(err).message, 'error');
        } finally {
            setBusy(null);
        }
    };

    const create = type.create;
    return (
        <RecordContext.Provider value={{ type, fmt }}>
            <QueryList<Rec>
                query={{ ...query, data: set?.rows }}
                renderItem={renderRecord}
                keyExtractor={(rec) => type.idOf(rec)}
                search={{ placeholder: t('common.search', 'Search'), match: (rec, needle) => matchesSearch(type, rec, needle, fmt) }}
                empty={{ icon: type.icon, title: labelText(type.empty.title, t), message: type.empty.message ? labelText(type.empty.message, t) : undefined }}
                noMatch={{ title: t('compliance.rail_search_empty', 'Nothing matches') }}
                ListHeaderComponent={<ListHeader type={type} actions={actions} onCreate={create ? () => setCreating(true) : null} onAction={(a) => void onAction(a)} busy={busy} />}
            />
            {creating && create ? (
                <RecordFormSheet
                    title={labelText(create.label, t)}
                    submitLabel={labelText(create.label, t)}
                    fields={create.fields}
                    initial={initialValues(create.fields)}
                    onClose={() => setCreating(false)}
                    onSubmit={async (values) => {
                        await write.mutateAsync(create.request(values, { t, context: set?.context ?? null, now: Date.now() }));
                        toast(create.success ? labelText(create.success, t) : t('common.saved', 'Saved'), 'success');
                    }}
                />
            ) : null}
        </RecordContext.Provider>
    );
}

const makeStyles = (theme: Theme) =>
    StyleSheet.create({
        header: { gap: theme.spacing[3], paddingHorizontal: theme.spacing.lg, paddingBottom: theme.spacing[3] },
        buttons: { flexDirection: 'row', flexWrap: 'wrap', gap: theme.spacing[2] },
    });
