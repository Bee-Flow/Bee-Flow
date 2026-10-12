/**
 * DIFFERENTIAL lockstep: `liveStateOf` against the web's
 * `Builder/header/liveState.ts`, run on the same rows (every combination of
 * the fields it reads, junk included). TEXTUAL for the words: every
 * `automations.header.*` key the phone's header, banner and model say goes out
 * with the English the web's header files give it. Plus unit tests for the
 * phone's own reading (whether the server has the split, the pending line).
 */

import fs from 'node:fs';

import { BUILDER, requireWeb, webPath } from '@/features/flow-editor/bindings/testing/web';

import { hasLiveSplit, liveStateOf, liveVersionWord, pendingText, type LiveRow } from './liveState';

const web = requireWeb(`${BUILDER}/header/liveState.ts`);
const WEB_HEADER = ['LiveStatusPill.tsx', 'LiveActions.tsx'].map((f) => fs.readFileSync(webPath(`${BUILDER}/header/${f}`), 'utf8'));
const WEB_BAR = fs.readFileSync(webPath(`${BUILDER}/BuilderHeader.tsx`), 'utf8');

const english = (_key: string, fallback: string, params?: Record<string, string | number>) =>
    fallback.replace(/\{(\w+)\}/g, (m, k: string) => (params && k in params ? String(params[k]) : m));

/** Every combination of the fields liveStateOf reads, each with a junk value among the real ones. */
function rows(): (LiveRow | null | undefined)[] {
    const out: (LiveRow | null | undefined)[] = [null, undefined, {}];
    for (const isActive of [true, false, undefined]) {
        for (const isDraft of [true, false, undefined]) {
            for (const liveVersion of [undefined, null, 0, 3, -1]) {
                for (const neverLive of [undefined, true, false]) {
                    for (const pendingChanges of [undefined, null, 0, 2, -1, Number.NaN]) {
                        for (const version of [5, null, '5' as unknown as number]) {
                            out.push({ isActive, isDraft, liveVersion, neverLive, pendingChanges, version });
                        }
                    }
                }
            }
        }
    }
    return out;
}

describe('liveStateOf decides as the web does', () => {
    it('on every row, with and without a counts figure', () => {
        const all = rows();
        expect(all.length).toBeGreaterThan(1000);
        for (const row of all) {
            for (const counts of [null, 0, 4]) {
                expect(liveStateOf(row, counts)).toEqual(web.liveStateOf?.(row, counts));
            }
            expect(liveStateOf(row)).toEqual(web.liveStateOf?.(row));
        }
    });

    it('offers Make live only on a live automation that is ahead', () => {
        expect(liveStateOf({ isActive: true, version: 5, liveVersion: 3, neverLive: false, pendingChanges: 2 }).primary).toBe('publish');
        expect(liveStateOf({ isActive: false, version: 5, liveVersion: 3, neverLive: false, pendingChanges: 2 }).primary).toBe('activate');
        expect(liveStateOf({ isActive: true, version: 3, liveVersion: 3, neverLive: false, pendingChanges: 0 }).primary).toBeNull();
        // A save's answer carries no count: the counts figure decides.
        expect(liveStateOf({ isActive: true, version: 6, liveVersion: 3, neverLive: false }, 1).primary).toBe('publish');
    });
});

describe('the words are the web header\'s', () => {
    const PAIR = /\bt\(\s*'(automations\.header\.[a-z_]+)',\s*'([^']*)'/g;
    const pairs = (src: string) => [...src.matchAll(PAIR)].map((m) => `${m[1]}|${m[2]}`);
    const webPairs = new Set([...WEB_HEADER, WEB_BAR].flatMap(pairs));

    it.each(['liveState.ts', 'PublishBanner.tsx', 'BuildHeader.tsx'])('%s says each automations.header key as the web does', (file) => {
        const mine = pairs(fs.readFileSync(`${__dirname}/${file}`, 'utf8'));
        expect(mine.length).toBeGreaterThan(0);
        expect(mine.filter((pair) => !webPairs.has(pair))).toEqual([]);
    });

    it('the web still shows Make vN live for the publish primary, and the pending line beside the pill', () => {
        const [pill, actions] = WEB_HEADER as [string, string];
        expect(actions).toContain("live.primary === 'publish'");
        expect(pill).toContain('live.pendingChanges === 1');
        expect(pill).toContain("live.kind !== 'never' && live.pendingChanges > 0");
    });
});

describe('the phone\'s reading', () => {
    it('knows the split by liveVersion being sent at all, null included', () => {
        expect(hasLiveSplit({ isActive: true, isDraft: false })).toBe(false);
        expect(hasLiveSplit({ liveVersion: null })).toBe(true);
        expect(hasLiveSplit({ liveVersion: 3 })).toBe(true);
        expect(hasLiveSplit(null)).toBe(false);
    });

    it('says what is pending, and nothing when the working copy is not ahead', () => {
        const live = (pendingChanges: number, isActive = true) => liveStateOf({ isActive, version: 5, liveVersion: 3, neverLive: false, pendingChanges });
        expect(pendingText(live(2), english)).toBe('editing v5 · 2 changes not live yet');
        expect(pendingText(live(1), english)).toBe('editing v5 · 1 change not live yet');
        expect(pendingText(live(1, false), english)).toBe('editing v5 · 1 change not live yet');
        expect(pendingText(live(0), english)).toBeNull();
        expect(pendingText(liveStateOf({ isActive: false, version: 2, liveVersion: null, neverLive: true, pendingChanges: 0 }), english)).toBeNull();
    });

    it('names the live version only for an automation switched on', () => {
        expect(liveVersionWord(liveStateOf({ isActive: true, version: 5, liveVersion: 3, neverLive: false }), english)).toBe('Live · v3');
        expect(liveVersionWord(liveStateOf({ isActive: false, version: 5, liveVersion: 3, neverLive: false }), english)).toBeNull();
        expect(liveVersionWord(null, english)).toBeNull();
    });
});
