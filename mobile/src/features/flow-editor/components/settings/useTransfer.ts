/**
 * Export and import, on the device: the export is written as a JSON FILE and
 * handed to Android's share sheet (an automation pasted into a chat app is
 * truncated by half of them; with no share target it goes to the clipboard),
 * and an import is a file picked with the document picker, read, and sent to
 * POST /import — which makes a NEW inactive draft with fresh step ids.
 */

import * as Clipboard from 'expo-clipboard';
import * as DocumentPicker from 'expo-document-picker';
import { Directory, File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';

import { describeError } from '@/core/api/errors';
import { useTranslation } from '@/core/i18n';
import type { SaveResult } from '@/features/flow-editor/api';
import { useExportFlow, useImportFlow } from '@/features/flow-editor/hooks';
import { useToast } from '@/shared/ui';

import { exportFileName, exportFileText, parseImportFile } from './transfer';

function writeExport(name: string, text: string): File {
    const dir = new Directory(Paths.cache, 'exports');
    if (!dir.exists) dir.create({ intermediates: true, idempotent: true });
    const file = new File(dir, name);
    if (file.exists) file.delete();
    file.create();
    file.write(text);
    return file;
}

/** Export this automation and share the file; resolves with the export's warnings (what was left out). */
export function useShareExport(flowKey: string, title: string) {
    const t = useTranslation();
    const { toast } = useToast();
    const exporter = useExportFlow(flowKey);
    const share = async (): Promise<string[]> => {
        try {
            const result = await exporter.mutateAsync();
            if (!result.envelope) {
                toast(t('mobile.flow.settings.export_empty', 'The server returned nothing to export.'), 'error');
                return [];
            }
            const text = exportFileText(result.envelope);
            if (await Sharing.isAvailableAsync()) {
                const file = writeExport(exportFileName(title), text);
                await Sharing.shareAsync(file.uri, { mimeType: 'application/json', dialogTitle: title, UTI: 'public.json' });
            } else {
                await Clipboard.setStringAsync(text);
                toast(t('mobile.flow.settings.export_copied', 'Copied the automation to the clipboard'), 'success');
            }
            return result.warnings;
        } catch (err) {
            toast(describeError(err).message, 'error');
            return [];
        }
    };
    return { share, busy: exporter.isPending };
}

/** Pick an automation file and import it as a new draft; `onImported` gets the result. */
export function usePickImport(onImported: (result: SaveResult) => void) {
    const t = useTranslation();
    const { toast } = useToast();
    const importer = useImportFlow({ onSuccess: onImported, onError: (err) => toast(describeError(err).message, 'error') });
    const pick = async () => {
        const picked = await DocumentPicker.getDocumentAsync({ type: ['application/json', 'text/plain', '*/*'], copyToCacheDirectory: true, multiple: false });
        const asset = picked.canceled ? undefined : picked.assets[0];
        if (!asset) return;
        let text = '';
        try {
            text = await new File(asset.uri).text();
        } catch (err) {
            toast(describeError(err).message, 'error');
            return;
        }
        const parsed = parseImportFile(text);
        if (!parsed.ok) {
            toast(t('mobile.flow.settings.import_not_automation', 'That file is not an exported automation.'), 'error');
            return;
        }
        importer.mutate(parsed.envelope);
    };
    return { pick: () => void pick(), busy: importer.isPending };
}
