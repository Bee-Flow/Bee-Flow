// What the page does besides editing cells: rename, download as CSV or Excel,
// add / rename / delete tabs (a refusal is said in a notice), and leave, switch
// tab or open in Studio once the queued cells are saved (useSheetGuard asks
// first when that save failed).

import { useState } from 'react';
import useTranslation from '@/hooks/useTranslation';
import type { StudioDocument } from '../documentQueries';
import { getDocument, updateDocument } from '../documentsApi';
import { downloadSheetCsv, downloadSheetXlsx } from '@/api/sheetApi';
import type { SheetState } from './useSheet';
import useSheetGuard from './useSheetGuard';
import { sheetErrorText } from './sheetErrorText';
import { messageOf } from '@/utils/caughtError';

export default function useSheetActions({ initial, sheet, onBack, onRenamed }: {
    initial: StudioDocument; sheet: SheetState; onBack?: () => void; onRenamed?: (doc: StudioDocument) => void;
}) {
    const { t } = useTranslation();
    const [name, setName] = useState(initial.name);
    const [notice, setNotice] = useState<string | null>(null);
    const [downloading, setDownloading] = useState(false);
    const unsaved = useSheetGuard(sheet);

    const rename = async (next: string) => {
        const trimmed = next.trim();
        if (!trimmed || trimmed === name) return;
        setNotice(null);
        try {
            // Saving cells may have moved the revision: rename on the newest.
            const latest = await getDocument(initial.id) as StudioDocument;
            const saved = await updateDocument(initial.id, { name: trimmed, expectedVersionId: latest.versionId }) as StudioDocument;
            setName(saved.name || trimmed);
            onRenamed?.(saved);
        } catch (e) { setNotice(messageOf(e, t('spreadsheet.rename_failed', 'Could not rename the spreadsheet.'))); }
    };
    const download = async (format: 'csv' | 'xlsx' = 'csv') => {
        setDownloading(true);
        setNotice(null);
        try {
            await sheet.flush();
            if (format === 'xlsx') await downloadSheetXlsx(initial.id, name);
            else await (sheet.activeTab
                ? downloadSheetCsv(initial.id, name, sheet.activeTab)
                : downloadSheetCsv(initial.id, name));
        } catch (e) {
            setNotice(messageOf(e, format === 'xlsx'
                ? t('spreadsheet.download_xlsx_failed', 'Could not download the Excel file.')
                : t('spreadsheet.download_failed', 'Could not download the CSV.')));
        } finally { setDownloading(false); }
    };
    /** A tab change; a refusal (tab cap, storage limit, the last tab) is said in the notice. */
    const tabAction = (run: () => Promise<unknown>, fallback: string) => {
        setNotice(null);
        return run().catch((e: unknown) => { setNotice(sheetErrorText(e, t, fallback)); });
    };
    const tabs = {
        add: () => tabAction(() => sheet.createTab(), t('doc_sheet.tab.add_failed', 'Could not add a tab.')),
        rename: (tabId: string, next: string) => tabAction(() => sheet.renameTab(tabId, next), t('doc_sheet.tab.rename_failed', 'Could not rename the tab.')),
        remove: (tabId: string) => tabAction(() => sheet.deleteTab(tabId), t('doc_sheet.tab.delete_failed', 'Could not delete the tab.')),
        show: (tabId: string) => unsaved.guard(() => sheet.setActiveTab(tabId)),
    };
    const leave = () => unsaved.guard(() => onBack?.());
    const openIn = (go: () => void) => unsaved.guard(go);
    return { name, notice, downloading, rename, download, leave, openIn, tabs, unsaved };
}
