/**
 * Import a spreadsheet file into the rows — the web's ImportPanel, fed from the
 * document picker instead of a paste. Each file column is pre-matched to a
 * table column by name and can be pointed elsewhere (or left out); the whole
 * file then goes in ONE request, and every line that did not land is listed by
 * its line in the file.
 */

import React, { useMemo, useState } from 'react';

import { ApiError } from '@/core/api/client';
import { useTranslation, type TranslateFn } from '@/core/i18n';
import { ActionMenu, Banner, Button, ListRow, Sheet, Text } from '@/shared/ui';

import { readBulkImport } from '../api/readers';
import { BULK_IMPORT_MAX } from '../api/rows';
import { useImportRows } from '../hooks/rowMutations';
import { columnLabel } from '../model/columns';
import { buildImportRows, parsePasted, suggestMapping } from '../model/csvImport';
import { importOutcome, planImport, type LineProblem } from '../model/importPlan';
import { editableColumns } from '../model/rowDraft';
import type { Column } from '../model/types';
import { cellErrorText } from '../model/words';

const SHOWN_PROBLEMS = 20;

function problemText(t: TranslateFn, p: LineProblem): string {
    const what = p.error ?? p.problems.map((x) => `${x.column}: ${cellErrorText(t, x.error.code, x.error.text)}`).join(' · ');
    return `${t('datatables.import_line', 'Line {n}', { n: p.line })} — ${what}`;
}

/** Why the import cannot start, or why it did not finish. */
function ImportNotices({ failed, mapped, tooMany }: { failed: boolean; mapped: boolean; tooMany: boolean }) {
    const t = useTranslation();
    return (
        <>
            {failed ? <Banner tone="error">{t('datatables.err_import', 'Could not import these rows')}</Banner> : null}
            {!mapped ? <Banner tone="warning">{t('datatables.import_unmapped', 'Point at least one column at a field first.')}</Banner> : null}
            {tooMany ? <Banner tone="warning">{t('mobile.datatables.import_too_many', 'An import carries at most {n} rows — split the file.', { n: BULK_IMPORT_MAX })}</Banner> : null}
        </>
    );
}

/** "12 rows imported · 2 skipped". */
function OutcomeLine({ inserted, failed }: { inserted: number; failed: number }) {
    const t = useTranslation();
    const done = inserted === 1 ? t('datatables.import_done_one', '1 row imported') : t('datatables.import_done', '{n} rows imported', { n: inserted });
    return (
        <Text variant="body" weight="semibold">
            {failed ? `${done} · ${t('datatables.import_skipped', '{n} skipped', { n: failed })}` : done}
        </Text>
    );
}

export function ImportSheet({ tableId, columns, file, onClose }: { tableId: string; columns: readonly Column[]; file: { name: string; text: string }; onClose: () => void }) {
    const t = useTranslation();
    const fields = useMemo(() => editableColumns(columns), [columns]);
    const parsed = useMemo(() => parsePasted(file.text), [file.text]);
    const [mapping, setMapping] = useState(() => suggestMapping(parsed.header, fields));
    const [picking, setPicking] = useState<number | null>(null);
    const [outcome, setOutcome] = useState<ReturnType<typeof importOutcome> | null>(null);
    const plan = useMemo(() => planImport(buildImportRows(parsed, mapping, fields)), [parsed, mapping, fields]);
    const run = useImportRows(tableId);
    const mapped = mapping.some(Boolean);
    const tooMany = plan.good.length > BULK_IMPORT_MAX;

    const start = () => {
        if (!plan.good.length) return setOutcome(importOutcome(plan, { inserted: 0, errors: [] }));
        run.mutate(
            plan.good.map((r) => r.values),
            {
                onSuccess: (answer) => setOutcome(importOutcome(plan, answer)),
                // 422: nothing could be written, and the body says why, line by line.
                onError: (err) => (err instanceof ApiError && err.status === 422 ? setOutcome(importOutcome(plan, readBulkImport(err.body))) : undefined),
            },
        );
    };
    // One field per column: pointing a second column at a field MOVES it.
    const point = (index: number, key: string) =>
        setMapping((cur) => cur.map((k, i) => (i === index ? key : key && k === key ? '' : k)));
    const nameOf = (key: string) => columnLabel(fields.find((f) => f.key === key));

    const footer = outcome ? (
        <Button fullWidth size="lg" label={t('mobile.datatables.done', 'Done')} onPress={onClose} />
    ) : (
        <Button
            fullWidth
            size="lg"
            label={plan.good.length === 1 ? t('datatables.import_one', 'Import 1 row') : t('datatables.import_n', 'Import {n} rows', { n: plan.good.length })}
            disabled={!mapped || tooMany || !parsed.rows.length}
            loading={run.isPending}
            onPress={start}
            testID="import-start"
        />
    );

    return (
        <Sheet visible tall onClose={onClose} title={file.name} subtitle={t('datatables.import_mapping', 'Where does each column go?')} footer={footer}>
            <ImportNotices failed={!!run.error && !(run.error instanceof ApiError && run.error.status === 422)} mapped={mapped} tooMany={tooMany} />
            {outcome ? (
                <OutcomeLine inserted={outcome.inserted} failed={outcome.failed.length} />
            ) : (
                parsed.header.map((h, i) => (
                    <ListRow
                        key={`${i}:${h}`}
                        title={h || t('datatables.import_column_n', 'Column {n}', { n: i + 1 })}
                        subtitle={mapping[i] ? nameOf(mapping[i] ?? '') : t('datatables.import_skip_column', 'Don’t import this one')}
                        onPress={() => setPicking(i)}
                        chevron
                    />
                ))
            )}
            {(outcome?.failed ?? plan.skipped).slice(0, SHOWN_PROBLEMS).map((p) => (
                <Text key={p.line} variant="caption" tone="warning">
                    {problemText(t, p)}
                </Text>
            ))}
            <ActionMenu
                visible={picking !== null}
                onClose={() => setPicking(null)}
                title={t('datatables.import_column_target', 'Where does “{name}” go?', { name: parsed.header[picking ?? 0] ?? '' })}
                items={[
                    { id: '', label: t('datatables.import_skip_column', 'Don’t import this one'), selected: !mapping[picking ?? 0], onPress: () => point(picking ?? 0, '') },
                    ...fields.map((f) => ({ id: f.key, label: columnLabel(f), selected: mapping[picking ?? 0] === f.key, onPress: () => point(picking ?? 0, f.key) })),
                ]}
            />
        </Sheet>
    );
}
