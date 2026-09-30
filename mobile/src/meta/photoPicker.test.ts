/**
 * Picking a photo never asks for a media-library permission.
 *
 * app.config.ts blocks READ_EXTERNAL_STORAGE and READ_MEDIA_IMAGES on
 * purpose: `launchImageLibraryAsync` opens Android's Photo Picker (or, on a
 * phone without it, the system's document picker), which hands the app only
 * the photos the person picks and needs no permission at all. A permission
 * the manifest does not declare can only be refused, so code that asked for
 * one first and gave up on "no" made every photo pick fail on Android 7–12,
 * where expo-image-picker still asks for the storage reads. This walks the
 * app for any such call.
 */

import fs from 'node:fs';
import path from 'node:path';

const MOBILE = path.resolve(__dirname, '../..');

/** expo-image-picker's media-library permission calls, and the hook around them. */
const ASKS = /\b(requestMediaLibraryPermissionsAsync|getMediaLibraryPermissionsAsync|useMediaLibraryPermissions)\b/;

function* sourceFiles(dir: string): Generator<string> {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, entry.name);
        if (entry.isDirectory()) yield* sourceFiles(p);
        else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) yield p;
    }
}

const files = ['app', 'src'].flatMap((root) => [...sourceFiles(path.join(MOBILE, root))]);

describe('photo picking needs no permission', () => {
    it('walks the app', () => {
        expect(files.length).toBeGreaterThan(150);
    });

    it('no source file asks for the media library', () => {
        const asking = files
            .filter((file) => ASKS.test(fs.readFileSync(file, 'utf8')))
            .map((file) => path.relative(MOBILE, file).replace(/\\/g, '/'));
        expect({ asking }).toEqual({ asking: [] });
    });

    it('the reason still holds: the manifest blocks the broad media reads', () => {
        const config = fs.readFileSync(path.join(MOBILE, 'app.config.ts'), 'utf8');
        const blocked = /blockedPermissions: \[([\s\S]*?)\]/.exec(config)?.[1] ?? '';
        for (const permission of ['READ_EXTERNAL_STORAGE', 'READ_MEDIA_IMAGES']) {
            expect(blocked).toContain(`'android.permission.${permission}'`);
        }
    });
});
