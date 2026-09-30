/**
 * The attention port held to the web's (textual lockstep): the six sources
 * and the Studio section each one is named after, and the five status lines.
 *
 * The web files import its API layer and React, so they are read as TEXT:
 *   - attentionChecks.js SOURCE_LABELS gives each source its KIND, and the
 *     web names a source by the Studio section of that kind
 *     (studioNav.studioAppForKind) — so SOURCE_SECTION must land on the
 *     registry section with that kind;
 *   - AttentionList.jsx draws one line per state, each with its own testid
 *     and `studio.attention.<line>` key — attentionLine must answer the same
 *     five.
 *
 * When this fails, the web side changed: update attention.ts to match.
 */

import fs from 'node:fs';
import path from 'node:path';

import { attentionLine, attentionSections, SOURCE_LABELS, SOURCE_SECTION } from './attention';
import { STUDIO_SECTIONS } from './registry';

const DIR = path.resolve(__dirname, '../../../../../agent-hub/src/components/admin/Studio/attention');
const CHECKS = fs.readFileSync(path.join(DIR, 'attentionChecks.js'), 'utf8');
const LIST = fs.readFileSync(path.join(DIR, 'AttentionList.jsx'), 'utf8');

/** `source: { kind: 'x', … }` inside `export const SOURCE_LABELS = Object.freeze({ … });`. */
function webSourceKinds(): Record<string, string> {
    const start = CHECKS.indexOf('export const SOURCE_LABELS');
    const body = CHECKS.slice(start, CHECKS.indexOf('});', start));
    return Object.fromEntries([...body.matchAll(/^\s+(\w+): \{ kind: '(\w+)'/gm)].map((m) => [m[1], m[2]]));
}

describe('attention matches the web', () => {
    it('knows the same six sources', () => {
        const web = webSourceKinds();
        expect(Object.keys(web)).toHaveLength(6);
        expect(Object.keys(SOURCE_SECTION).sort()).toEqual(Object.keys(web).sort());
    });

    it('words each source as the web does', () => {
        const start = CHECKS.indexOf('export const SOURCE_LABELS');
        const body = CHECKS.slice(start, CHECKS.indexOf('});', start));
        const web = Object.fromEntries(
            [...body.matchAll(/^\s+(\w+): \{ kind: '\w+', key: '([\w.]+)', fallback: '([^']+)'/gm)].map((m) => [m[1], [m[2], m[3]]]),
        );
        expect(Object.keys(web)).toHaveLength(6);
        expect(SOURCE_LABELS).toEqual(web);
    });

    it('names each source by the Studio section of its kind, as studioAppForKind does', () => {
        for (const [source, kind] of Object.entries(webSourceKinds())) {
            const section = STUDIO_SECTIONS.find((s) => s.kind === kind)?.id;
            expect({ source, section: attentionSections([source])[0] }).toEqual({ source, section });
        }
    });

    it('answers the five lines the web draws', () => {
        const web = [...LIST.matchAll(/data-testid="studio-attention-(empty|empty-capped|empty-unchecked|partial|partial-capped)"/g)]
            .map((m) => (m[1] as string).replace(/-/g, '_'))
            .sort();
        const none = { unavailable: [] as string[], capped: [] as string[] };
        const ours = [
            attentionLine({ total: 0, complete: true, ...none }),
            attentionLine({ total: 0, complete: false, unavailable: [], capped: ['agentNoKb'] }),
            attentionLine({ total: 0, complete: false, unavailable: ['agentNoKb'], capped: [] }),
            attentionLine({ total: 2, complete: false, unavailable: ['agentNoKb'], capped: [] }),
            attentionLine({ total: 2, complete: false, unavailable: [], capped: ['agentNoKb'] }),
        ].sort();
        expect(ours).toEqual(web);
        for (const line of ours) expect(LIST).toContain(`'studio.attention.${line}'`);
    });
});
