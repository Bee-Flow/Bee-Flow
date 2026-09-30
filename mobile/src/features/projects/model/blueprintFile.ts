/**
 * A Blueprint someone handed over as a file: picked from the device, read,
 * and checked to be a JSON object before it goes anywhere near the server.
 *
 * The server's installer is the authority on what a manifest may contain;
 * this only refuses what is plainly not one (not JSON, not an object, or
 * larger than the server would ever store), so a wrong file is said on the
 * phone rather than as a 400 after the upload.
 */

import * as DocumentPicker from 'expo-document-picker';
import { File } from 'expo-file-system';

/** Well above the server's stored-Blueprint ceiling; beyond it, reading it is the problem. */
const MAX_BYTES = 25 * 1024 * 1024;

export type PickedBlueprint =
    | { kind: 'ok'; manifest: Record<string, unknown>; fileName: string }
    | { kind: 'cancelled' }
    | { kind: 'not-a-blueprint' }
    | { kind: 'too-large' };

/** Parse a file's text; only a JSON OBJECT can be a Blueprint. */
export function parseBlueprint(text: string): Record<string, unknown> | null {
    try {
        const parsed: unknown = JSON.parse(text);
        return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
            ? (parsed as Record<string, unknown>)
            : null;
    } catch {
        return null;
    }
}

export async function pickBlueprintFile(): Promise<PickedBlueprint> {
    const result = await DocumentPicker.getDocumentAsync({
        type: ['application/json', 'text/plain', '*/*'],
        copyToCacheDirectory: true,
        multiple: false,
    });
    const asset = result.canceled ? null : result.assets[0];
    if (!asset) return { kind: 'cancelled' };
    if ((asset.size ?? 0) > MAX_BYTES) return { kind: 'too-large' };
    const manifest = parseBlueprint(await new File(asset.uri).text());
    if (!manifest) return { kind: 'not-a-blueprint' };
    return { kind: 'ok', manifest, fileName: asset.name || 'Blueprint' };
}
