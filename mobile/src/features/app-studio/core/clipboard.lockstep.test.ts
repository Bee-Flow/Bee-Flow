/**
 * Differential lockstep: core/clipboard against the web's state/clipboard.js,
 * on the same fixtures and the same seeded ids.
 */

import * as port from './clipboard';
import { walkNodes } from './ops';
import { allFixtures, withSeed } from './testing/fixtures';
import { loadWeb } from './testing/loadWeb';
import type { AppDefinition } from './types';

type AnyFn = (...args: unknown[]) => unknown;
const web = loadWeb<Record<string, unknown>>('state/clipboard.js');

function both(name: string, ...args: unknown[]): unknown {
    const w = withSeed(11, () => (web[name] as AnyFn)(...args));
    const p = withSeed(11, () => ((port as unknown as Record<string, AnyFn>)[name] as AnyFn)(...args));
    expect(p).toEqual(w);
    return p;
}

function ids(def: AppDefinition): string[] {
    const out: string[] = [];
    walkNodes(def, ({ node }) => out.push(node.id));
    return out;
}

describe.each(Object.entries(allFixtures()))('clipboard on %s', (_name, def) => {
    it('serializes and pastes the same way', () => {
        const all = ids(def);
        const selections = [[], all, all.slice(0, 2), all.slice(-3).reverse(), new Set(all.slice(1, 4)), ['cmp_nope00'], null];
        const screens = (def.screens || []).map((s) => s.id);
        const sections = (def.screens || []).flatMap((s) => (s.sections || []).map((x) => x.id));
        for (const sel of selections) {
            const payload = both('serializeNodes', def, sel);
            const targets = [
                {},
                { sectionId: sections[1] ?? 'sec_nope01', index: 0 },
                { screenId: screens[1] ?? screens[0], index: 1 },
                { sectionId: 'sec_nope01', screenId: 'scr_nope01' },
                { index: 1.5 },
            ];
            for (const target of targets) both('pasteNodes', def, payload, target);
        }
        both('pasteNodes', def, { kind: 'other', nodes: [{ type: 'text' }] }, {});
        both('pasteNodes', def, { kind: port.CLIPBOARD_KIND, nodes: [null, { id: 'x' }, { type: 'text' }] }, {});
        both('pasteNodes', def, null, {});
    });
});

describe('the buffer', () => {
    it('behaves the same', () => {
        const payloads = [null, { kind: port.CLIPBOARD_KIND, nodes: [] }, { kind: port.CLIPBOARD_KIND, nodes: [{ type: 'text' }] }];
        for (const payload of payloads) {
            (web.setClipboard as AnyFn)(payload);
            port.setClipboard(payload as port.ClipboardPayload | null);
            expect(port.getClipboard()).toEqual((web.getClipboard as AnyFn)());
            expect(port.hasClipboard()).toBe((web.hasClipboard as AnyFn)());
        }
    });

    it('exports every name the web module exports', () => {
        expect(Object.keys(web).filter((k) => k !== 'default' && !(k in port))).toEqual([]);
        expect(port.CLIPBOARD_KIND).toBe(web.CLIPBOARD_KIND);
    });
});
