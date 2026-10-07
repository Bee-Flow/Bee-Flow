/**
 * A register as a searchable list (web: each page's DataTable in its phone
 * card layout): the page's intro, its list buttons (seed the templates,
 * download the register, read again), a create button, the filter pills with
 * their counts, the status line (RecordHeader), the register's own panel, and
 * a row per record that opens its detail. With filters the top block sits
 * above the list, so the pills stay when a filter leaves no rows (QueryList
 * drops its header for the empty state).
 */

import { useRouter } from 'expo-router';
import React, { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { describeError } from '@/core/api/errors';
import { useTranslation, type TranslateFn } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { QueryList } from '@/shared/patterns';
import { Button, EmptyState, Text, useToast } from '@/shared/ui';

import { RecordFilters } from './RecordFilters';
import { RecordFormSheet } from './RecordFormSheet';
import { RecordHeader } from './RecordHeader';
import type { RecordPanels } from './recordPanels';
import { RecordContext, renderRecord } from './RecordRow';
import { shareDownload } from '../api/endpoints';
import { useComplianceWrite } from '../hooks/mutations';
import { useRecords } from '../hooks/queries';
import { actionError } from '../hooks/useActionRunner';
import { useFormatter } from '../hooks/useFormatter';
import { initialValues, labelText, matchesSearch, usesMembers } from '../model/fields';
import { defaultFilters, passesFilters } from '../model/filters';
import { recordRoute } from '../model/navigation';
import type { Formatter, ListActionSpec, Rec, RecordSet, RecordType } from '../model/types';

type Records = ReturnType<typeof useRecords>;

interface TopProps {
    type: RecordType;
    set: RecordSet | undefined;
    fmt: Formatter;
    actions: readonly ListActionSpec[];
    onCreate: (() => void) | null;
    onAction: (action: ListActionSpec) => void;
    busy: string | null;
    panels?: RecordPanels;
    filters?: React.ReactNode;
}

function ListTop({ type, set, fmt, actions, onCreate, onAction, busy, panels, filters }: TopProps) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    const Panel = panels?.ListTop;
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
                        label={a.labelFor && set ? a.labelFor(set, t) : labelText(a.label, t)}
                        onPress={() => onAction(a)}
                    />
                ))}
            </View>
            {filters}
            {set ? <RecordHeader type={type} set={set} fmt={fmt} /> : null}
            {Panel && set ? <Panel type={type} set={set} /> : null}
        </View>
    );
}

function listSuccess(action: ListActionSpec, result: unknown, t: TranslateFn): string {
    const s = action.success;
    if (typeof s === 'function') return s(result, t);
    return s ? labelText(s, t) : t('common.saved', 'Saved');
}

/** The list buttons: a download, a refetch, or a write with its toast. */
function useListActions(query: Records) {
    const t = useTranslation();
    const { toast } = useToast();
    const write = useComplianceWrite();
    const [busy, setBusy] = useState<string | null>(null);
    const onAction = async (action: ListActionSpec) => {
        setBusy(action.id);
        try {
            if (action.download) await shareDownload(action.download);
            else if (action.refresh) await query.refetch();
            else if (action.request) toast(listSuccess(action, await write.mutateAsync(action.request()), t), 'success');
        } catch (err) {
            toast(describeError(err).message, 'error');
        } finally {
            setBusy(null);
        }
    };
    return { busy, onAction: (a: ListActionSpec) => void onAction(a) };
}

function CreateSheet({ type, set, onClose }: { type: RecordType; set: RecordSet | undefined; onClose: () => void }) {
    const t = useTranslation();
    const router = useRouter();
    const { toast } = useToast();
    const write = useComplianceWrite();
    const create = type.create;
    if (!create) return null;
    const success = create.success;
    return (
        <RecordFormSheet
            title={labelText(create.label, t)}
            subtitle={create.description ? labelText(create.description, t) : undefined}
            submitLabel={labelText(create.submitLabel ?? create.label, t)}
            fields={create.fields}
            initial={initialValues(create.fields)}
            validate={create.validate ? (values) => create.validate?.(values, t) ?? {} : undefined}
            onClose={onClose}
            onSubmit={async (values) => {
                let result: unknown;
                try {
                    result = await write.mutateAsync(create.request(values, { t, context: set?.context ?? null, now: Date.now() }));
                } catch (err) {
                    throw actionError(create, err, t);
                }
                toast(typeof success === 'function' ? success(result, t) : success ? labelText(success, t) : t('common.saved', 'Saved'), 'success');
                const id = create.openAfter?.(result);
                if (id) router.push(recordRoute(type.id, id));
            }}
        />
    );
}

/** The type's own words for a failed read, when it has them. */
function ListError({ type, query }: { type: RecordType; query: Records }) {
    const t = useTranslation();
    const view = type.errorState?.(query.error);
    if (!view) return null;
    return (
        <EmptyState
            icon={type.icon}
            title={labelText(view.title, t)}
            message={view.message ? labelText(view.message, t) : undefined}
            actionLabel={view.retry ? t('mobile.error.retry', 'Try again') : undefined}
            onAction={view.retry ? () => void query.refetch() : undefined}
        />
    );
}

export function RecordList({ type, panels }: { type: RecordType; panels?: RecordPanels }) {
    const styles = useThemedStyles(makeStyles);
    const fmt = useFormatter(usesMembers(type));
    const query = useRecords(type, true);
    const { busy, onAction } = useListActions(query);
    const [creating, setCreating] = useState(false);
    const [active, setActive] = useState(() => defaultFilters(type.filters));
    const set = query.data;
    const actions = (type.listActions ?? []).filter((a) => !a.when || (set ? a.when(set) : false));
    const groups = type.filters?.length ? type.filters : null;
    const failed = Boolean(query.isError && set === undefined && type.errorState?.(query.error));
    const filters = groups ? (
        <RecordFilters groups={groups} rows={set?.rows ?? []} active={active} onChange={(g, o) => setActive((prev) => ({ ...prev, [g]: o }))} fmt={fmt} />
    ) : null;
    const top = (
        <ListTop
            type={type}
            set={set}
            fmt={fmt}
            actions={actions}
            onCreate={type.create ? () => setCreating(true) : null}
            onAction={onAction}
            busy={busy}
            panels={panels}
            filters={filters}
        />
    );
    return (
        <RecordContext.Provider value={{ type, fmt }}>
            {groups ? <View style={styles.fixed}>{top}</View> : null}
            {failed ? (
                <ListError type={type} query={query} />
            ) : (
                <Rows type={type} query={query} fmt={fmt} filter={groups ? (rec) => passesFilters(groups, active, rec, fmt.now) : undefined} header={groups ? null : top} />
            )}
            {creating ? <CreateSheet type={type} set={set} onClose={() => setCreating(false)} /> : null}
        </RecordContext.Provider>
    );
}

interface RowsProps {
    type: RecordType;
    query: Records;
    fmt: Formatter;
    filter: ((rec: Rec) => boolean) | undefined;
    header: React.ReactElement | null;
}

function Rows({ type, query, fmt, filter, header }: RowsProps) {
    const t = useTranslation();
    return (
        <QueryList<Rec>
            query={{ ...query, data: query.data?.rows }}
            renderItem={renderRecord}
            keyExtractor={(rec) => type.idOf(rec)}
            filter={filter}
            search={{
                placeholder: type.searchPlaceholder ? labelText(type.searchPlaceholder, t) : t('common.search', 'Search'),
                match: (rec, needle) => matchesSearch(type, rec, needle, fmt),
            }}
            empty={{ icon: type.icon, title: labelText(type.empty.title, t), message: type.empty.message ? labelText(type.empty.message, t) : undefined }}
            noMatch={{ title: t('compliance.rail_search_empty', 'Nothing matches') }}
            ListHeaderComponent={header}
        />
    );
}

const makeStyles = (theme: Theme) =>
    StyleSheet.create({
        header: { gap: theme.spacing[3], paddingHorizontal: theme.spacing.lg, paddingBottom: theme.spacing[3] },
        buttons: { flexDirection: 'row', flexWrap: 'wrap', gap: theme.spacing[2] },
        fixed: { paddingTop: theme.spacing.xs },
    });
