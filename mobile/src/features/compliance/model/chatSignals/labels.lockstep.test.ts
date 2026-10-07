/**
 * Textual lockstep: every code the web's chatMonitoringLabels.ts names maps
 * to the same literal key here, per function and in the same order; the
 * ROPA preview uses the same keys as RopaPreview.tsx. The English may differ
 * (surface.direct_hint already says the Android app counts).
 */
import fs from 'node:fs';
import path from 'node:path';

import { missingLabel, surfaceHint, surfaceLabel } from './labels';

const WEB = path.resolve(__dirname, '../../../../../../agent-hub/src/components/admin/compliance/pages/settings/chatMonitoring');
const HERE = __dirname;
const read = (dir: string, file: string) => fs.readFileSync(path.join(dir, file), 'utf8');

/** [function, code, key] for every `case 'code': return t('key'` and bare `t('key'` per exported/inner function. */
function pairs(src: string): string[][] {
    const out: string[][] = [];
    let fn = '';
    for (const line of src.split('\n')) {
        const head = /function (\w+)\(/.exec(line);
        if (head) fn = head[1]!;
        const codes = [...line.matchAll(/case '([^']+)':/g)].map((m) => m[1]!).join('|');
        for (const m of line.matchAll(/\bt\('([^']+)'/g)) out.push([fn, codes, m[1]!]);
    }
    return out;
}

const t = (key: string, fallback: string) => `${key}::${fallback}`;

describe('chat-signals labels lockstep', () => {
    it('maps every code to the web key', () => {
        const web = pairs(read(WEB, 'chatMonitoringLabels.ts'));
        expect(web.length).toBeGreaterThan(60);
        expect(pairs(read(HERE, 'labels.ts'))).toEqual(web);
    });

    it('builds the ROPA preview from the web keys', () => {
        const src = read(WEB, 'RopaPreview.tsx');
        const web = pairs(src.slice(src.indexOf('function legalBasisText'), src.indexOf('function Row')));
        expect(pairs(read(HERE, 'ropaPreview.ts'))).toEqual(web);
    });

    it('falls back to the code, and says the Android app counts', () => {
        expect(surfaceLabel(t, 'future_surface')).toBe('future_surface');
        expect(missingLabel(t, 'something_new')).toBe('something_new');
        expect(missingLabel(t, 'dpia')).toBe('chat_monitoring.missing.dpia::A current DPIA');
        expect(surfaceHint(t, 'direct')).toBe(
            'chat_monitoring.surface.direct_hint::Including the Swarm tier and chats shared into a project. The web, desktop and Android apps count.',
        );
    });
});
