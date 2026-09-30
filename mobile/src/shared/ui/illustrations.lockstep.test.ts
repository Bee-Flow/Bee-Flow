/**
 * The empty-state scenes are the web's (shared/illustrations.tsx), path for
 * path. This reads both sources and compares the scene names and every
 * drawing instruction in order, so a redrawn scene on the web fails here
 * instead of leaving the phone with the old picture.
 */

import fs from 'node:fs';
import path from 'node:path';

const WEB = path.resolve(__dirname, '../../../../agent-hub/src/components/shared/illustrations.tsx');
const PHONE = path.join(__dirname, 'illustrations.tsx');

/** Each drawing element as `tag attrs`, tag lower-cased, attributes in source order. */
function strokes(src: string): string[] {
    const out: string[] = [];
    for (const m of src.matchAll(/<(path|circle|Path|Circle)\s([^>]*?)\/>/g)) {
        const attrs = (m[2] as string).replace(/\s+/g, ' ').trim()
            // The web's accent is a CSS variable; the phone's is a prop of the same name.
            .replace(/stroke=\{ACCENT\}|stroke=\{accent\}/, 'stroke={accent}');
        out.push(`${(m[1] as string).toLowerCase()} ${attrs}`);
    }
    return out;
}

function sceneNames(src: string): string[] {
    const body = /export const ILLUSTRATIONS[^\n]*= \{([\s\S]*?)\};/.exec(src)?.[1] ?? '';
    return [...body.matchAll(/^\s*'?([a-z-]+)'?:/gm)].map((m) => m[1] as string);
}

describe('illustrations.tsx against the web', () => {
    const web = fs.readFileSync(WEB, 'utf8');
    const phone = fs.readFileSync(PHONE, 'utf8');

    it('offers the same scenes under the same names', () => {
        expect(sceneNames(phone)).toEqual(sceneNames(web));
        expect(sceneNames(phone)).toHaveLength(6);
    });

    it('draws every scene with the same strokes, in order', () => {
        // 19 strokes across the six scenes; an empty match would pass vacuously.
        expect(strokes(web).length).toBeGreaterThan(15);
        expect(strokes(phone)).toEqual(strokes(web));
    });
});
