/**
 * The design presets and number bounds held to the web's Design tab
 * (agent-hub/src/pages/documents/DocumentWorkspacePanel.jsx) — a textual
 * lockstep test: the web keeps them as literals in a component module, so
 * they are read out of the source rather than imported.
 *
 * When this fails, the web side changed: update model/design.ts to match.
 */

import fs from 'node:fs';
import path from 'node:path';

import { DESIGN_NUMBERS, DESIGN_PRESETS } from './design';

const WEB = path.resolve(__dirname, '../../../../../agent-hub/src/pages/documents/DocumentWorkspacePanel.jsx');
const describeIfWeb = fs.existsSync(WEB) ? describe : describe.skip;

/** `{neutral:{accent:'#334155',fontSize:11}}` → a plain object. */
function literal(source: string): unknown {
    const json = source.replace(/([{,])\s*([A-Za-z_]\w*)\s*:/g, '$1"$2":').replace(/'/g, '"');
    return JSON.parse(json);
}

describeIfWeb('the design controls match the web Design tab', () => {
    const source = fs.existsSync(WEB) ? fs.readFileSync(WEB, 'utf8') : '';

    it('has the same presets', () => {
        const match = /const PRESETS = (\{.*?\}\});/.exec(source);
        expect(match).not.toBeNull();
        expect(literal(match?.[1] ?? '{}')).toEqual(DESIGN_PRESETS);
    });

    it('bounds every number field as the web does', () => {
        const rows = [...source.matchAll(/\['(\w+)',d\('[^']*','[^']*'\),([\d.]+),([\d.]+),([\d.]+),([\d.]+)\]/g)].map((m) => ({
            key: m[1],
            min: Number(m[2]),
            max: Number(m[3]),
            step: Number(m[4]),
            fallback: Number(m[5]),
        }));
        expect(rows).toEqual(DESIGN_NUMBERS);
    });
});
