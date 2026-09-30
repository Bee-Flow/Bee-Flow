/**
 * Getting a spreadsheet off the device: the document picker (Drive,
 * Downloads, any SAF provider), copied into the cache so the content:// uri
 * cannot be revoked mid-read, then read as text.
 *
 * Text formats only — .csv, .tsv and a tab-separated .txt. An .xlsx is a zip
 * the phone has no parser for; the web's link-a-spreadsheet flow is where that
 * belongs.
 */

import * as DocumentPicker from 'expo-document-picker';
import { File } from 'expo-file-system';

/** The largest file read into memory: the import sends at most 5,000 rows anyway. */
export const MAX_CSV_BYTES = 5 * 1024 * 1024;

export type PickedCsv = { name: string; text: string } | { name: string; tooLarge: true };

/** Null when the person backs out — cancelling is not an error. */
export async function pickCsv(): Promise<PickedCsv | null> {
    const result = await DocumentPicker.getDocumentAsync({
        copyToCacheDirectory: true,
        multiple: false,
        type: ['text/csv', 'text/comma-separated-values', 'text/tab-separated-values', 'text/plain'],
    });
    if (result.canceled) return null;
    const asset = result.assets[0];
    if (!asset) return null;
    const name = asset.name || 'import.csv';
    if ((asset.size ?? 0) > MAX_CSV_BYTES) return { name, tooLarge: true };
    return { name, text: await new File(asset.uri).text() };
}
