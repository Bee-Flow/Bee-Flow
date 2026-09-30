/**
 * TEXTUAL lockstep: the composer's shield claims against the web's
 * SHIELD_LINES (composerClaims.js), and the choice between them run over the
 * statuses the server can send.
 */

import fs from 'node:fs';

import { AGENT_HUB_SRC } from '@/shared/testing/webModule';

import { SHIELD_LINES, shieldLine } from './shieldLine';
import type { ShieldStatus } from '../api/composerStatus';

const SRC = fs.readFileSync(`${AGENT_HUB_SRC}/components/chat/composerClaims.js`, 'utf8');
const HOOK = fs.readFileSync(`${AGENT_HUB_SRC}/hooks/useShieldStatus.ts`, 'utf8');

const status = (over: Partial<ShieldStatus>): ShieldStatus => ({
    enabled: true,
    source: 'org',
    action: 'redact',
    failMode: 'closed',
    guardReachable: true,
    euMode: false,
    coworkEnabled: false,
    ...over,
});

it("words every claim as the web does, with the web's keys and tones", () => {
    const block = SRC.slice(SRC.indexOf('export const SHIELD_LINES'), SRC.indexOf('export function shieldLine'));
    const web = [...block.matchAll(/(\w+): Object\.freeze\(\{\s*tone: '(\w+)', key: '([^']+)',\s*en: '([^']+)',/g)].map((m) => ({
        name: m[1],
        tone: m[2],
        i18nKey: m[3],
        en: m[4],
    }));
    expect(Object.entries(SHIELD_LINES).map(([name, w]) => ({ name, ...w }))).toEqual(web);
});

it('claims a shield only while its detector is reachable (the one rule)', () => {
    expect(HOOK).toContain("const shieldActive = data.enabled === true && data.guardReachable === true;");
    expect(HOOK).toContain("replacesPersonalData: shieldActive && data.action === 'redact'");
});

it.each([
    [status({}), SHIELD_LINES.replaces],
    [status({ action: 'block' }), SHIELD_LINES.blocks],
    [status({ action: 'ask' }), SHIELD_LINES.asks],
    [status({ action: 'log' }), SHIELD_LINES.checks],
    [status({ guardReachable: false }), SHIELD_LINES.unverified],
    [status({ enabled: false }), null],
    [null, null],
])('%j', (data, expected) => {
    expect(shieldLine(data)).toEqual(expected);
});
