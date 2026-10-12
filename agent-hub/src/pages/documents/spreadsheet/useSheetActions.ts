// What the page does besides editing cells: rename, download as CSV, leave
// (after the queued cells were sent).

import { useState } from 'react';
import useTranslation from '../../../hooks/useTranslation';
import type { StudioDocument } from '../documentQueries';
import { getDocument, updateDocument } from '../documentsApi';
import { downloadSheetCsv } from './sheetApi';
import type { SheetState } from './useSheet';

export default function useSheetActions({ initial, sheet, onBack, onRenamed }: {
    initial: StudioDocument; sheet: SheetState; onBack?: () => void; onRenamed?: (doc: StudioDocument) => void;
}) {
    const { t } = useTranslation();
    const [name, setName] = useState(initial.name);
    const [notice, setNotice] = useState<string | null>(null);
    const [downloading, setDownloading] = useState(false);

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
        } catch (e) { setNotice((e as Error).message || t('spreadsheet.rename_failed', 'Could not rename the spreadsheet.')); }
    };
    const download = async () => {
        setDownloading(true);
        setNotice(null);
        try {
            await sheet.flush();
            await (sheet.activeTab
                ? downloadSheetCsv(initial.id, name, sheet.activeTab)
                : downloadSheetCsv(initial.id, name));
        } catch (e) { setNotice((e as Error).message || t('spreadsheet.download_failed', 'Could not download the CSV.')); } finally { setDownloading(false); }
    };
    const leave = async () => {
        await sheet.flush();
        onBack?.();
    };
    return { name, notice, downloading, rename, download, leave };
}
