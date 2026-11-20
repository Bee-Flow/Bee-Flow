// What the spreadsheet editor says above the grid: a refused page action, a
// failed save (with Retry), a chart that could not be saved, a paste that did
// not fit, and the question when a tab or the editor is left while the last
// changes could not be saved.

import ConfirmDialog from '@/components/shared/ConfirmDialog';
import useTranslation, { type TranslateFn } from '@/hooks/useTranslation';
import { BUTTON, Notice } from './SheetStates';
import { sheetErrorText } from './sheetErrorText';
import type { GridLimit } from './useGridState';
import type { SheetState } from './useSheet';
import type { SheetGuard } from './useSheetGuard';

/** The sentence for a failed save, or null while nothing failed. */
function saveFailureText(sheet: Pick<SheetState, 'error' | 'status'>, t: TranslateFn): string | null {
    if (!sheet.error || sheet.status !== 'error') return null;
    return sheetErrorText(sheet.error, t, t('spreadsheet.save_failed', 'Could not save your changes.'));
}

function limitText(limit: GridLimit, t: TranslateFn): string {
    if (limit.kind === 'rows') return t('doc_sheet.limit.rows', 'A spreadsheet has at most 2,000 rows.');
    const parts: string[] = [];
    if (limit.rows) parts.push(t('doc_sheet.limit.paste_rows', 'A spreadsheet has at most 2,000 rows; {count} rows were not pasted.', { count: limit.rows }));
    if (limit.columns) parts.push(t('doc_sheet.limit.paste_columns', 'A spreadsheet has columns A to Z; {count} columns were not pasted.', { count: limit.columns }));
    return parts.join(' ');
}

interface Props {
    sheet: SheetState;
    notice: string | null;
    chartError: Error | null;
    limit: GridLimit | null;
    onDismissLimit: () => void;
    unsaved: SheetGuard;
}

export default function SheetEditorNotices({ sheet, notice, chartError, limit, onDismissLimit, unsaved }: Props) {
    const { t } = useTranslation();
    const saveFailure = saveFailureText(sheet, t);
    return (
        <>
            {notice && <Notice>{notice}</Notice>}
            {saveFailure && <Notice action={<button type="button" className={BUTTON} onClick={sheet.retry}>{t('spreadsheet.retry', 'Retry')}</button>}>{saveFailure}</Notice>}
            {chartError && <Notice>{sheetErrorText(chartError, t, t('doc_sheet.chart.failed', 'The charts of this spreadsheet could not be saved or loaded. Try again.'))}</Notice>}
            {limit && (
                <Notice action={<button type="button" className={BUTTON} onClick={onDismissLimit}>{t('common.dismiss', 'Dismiss')}</button>}>
                    {limitText(limit, t)}
                </Notice>
            )}
            <ConfirmDialog
                open={unsaved.blocked}
                title={t('doc_sheet.unsaved.title', 'Your last changes are not saved')}
                description={t('doc_sheet.unsaved.body', '{reason} If you go on, the changes that were not saved are lost.', {
                    reason: saveFailure ?? t('spreadsheet.save_failed', 'Could not save your changes.'),
                })}
                confirmLabel={t('doc_sheet.unsaved.leave', 'Leave anyway')}
                cancelLabel={t('doc_sheet.unsaved.stay', 'Stay')}
                destructive
                onConfirm={() => unsaved.leaveAnyway()}
                onCancel={unsaved.stay}
            />
        </>
    );
}
