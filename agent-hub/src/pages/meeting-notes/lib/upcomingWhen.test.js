// @vitest-environment node
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, it, expect } from 'vitest';

import { parseWhen, meetingDurationMinutes, dateBlockParts, timeRange } from './upcomingWhen';

/**
 * De datumregels van een Gepland-rij.
 *
 * ── WAAROM HIER EEN KINDPROCES IN STAAT ───────────────────────────────
 * De hele-dag-fix (een kale DATUM is LOKALE middernacht, niet UTC-middernacht)
 * is in UTC NIET te toetsen: daar geven `new Date('2026-07-18')` en
 * `new Date(2026, 6, 18)` exact dezelfde dag, dus elke assertie erover blijft
 * groen als iemand de fix terugdraait — en de container draait op TZ=UTC. Een
 * POSITIEVE offset (Europe/Amsterdam) haalt hem net zo min binnen: UTC-
 * middernacht valt daar op dezelfde kalenderdag. Alleen westwaarts schuift de
 * dag terug.
 * `process.env.TZ` tijdens de test aanpassen werkt niet in de vitest-worker
 * (die heeft zijn zone al vast). Daarom draait de assertie in een kindproces
 * met TZ=America/New_York — en daarom heeft `upcomingWhen.js` geen imports:
 * zonder bundler is hij dan gewoon te importeren.
 */

// `import.meta.url` is in de vitest-worker geen file:-URL, dus het pad komt
// uit de werkmap (de suite draait per contract vanuit agent-hub/).
const MODULE_PATH = path.resolve(process.cwd(), 'src/pages/meeting-notes/lib/upcomingWhen.js');
const MODULE_URL = pathToFileURL(MODULE_PATH).href;

function inZone(tz, expression) {
    const out = execFileSync(
        process.execPath,
        ['--input-type=module', '-e', `
            const m = await import(${JSON.stringify(MODULE_URL)});
            process.stdout.write(JSON.stringify(${expression}));
        `],
        { env: { ...process.env, TZ: tz }, encoding: 'utf8' },
    );
    return JSON.parse(out);
}

describe('upcomingWhen — parseWhen', () => {
    it('leest een tijdstip en een Date', () => {
        expect(parseWhen('2026-07-18T09:00:00Z').dateOnly).toBe(false);
        expect(parseWhen(new Date('2026-07-18T09:00:00Z')).dateOnly).toBe(false);
    });

    it('onbekend blijft onbekend — nooit "nu"', () => {
        for (const bad of [null, undefined, '', '   ', 'gisteren', new Date('nope')]) {
            expect(parseWhen(bad)).toBeNull();
        }
    });

    it('markeert een kale datum als dateOnly', () => {
        expect(parseWhen('2026-07-18')).toMatchObject({ dateOnly: true });
    });
});

describe('upcomingWhen — duur en tijdvak', () => {
    it('een hele dag heeft geen duur en geen tijdvak', () => {
        expect(meetingDurationMinutes('2026-07-18', '2026-07-19')).toBeNull();
        expect(timeRange('2026-07-18', '2026-07-19')).toBe('');
    });

    it('een einde dat niet ná het begin ligt is geen duur', () => {
        expect(meetingDurationMinutes('2026-07-18T09:00:00Z', '2026-07-18T09:00:00Z')).toBeNull();
        expect(meetingDurationMinutes('2026-07-18T09:00:00Z', '2026-07-18T08:00:00Z')).toBeNull();
        expect(meetingDurationMinutes('2026-07-18T09:00:00Z', null)).toBeNull();
    });

    it('telt hele minuten', () => {
        expect(meetingDurationMinutes('2026-07-18T09:00:00Z', '2026-07-18T10:30:00Z')).toBe(90);
    });
});

describe('upcomingWhen — de hele-dag-fix, in de zone waar hij over gaat', () => {
    it('het bestand blijft importloos, anders kan het kindproces hem niet laden', async () => {
        expect(existsSync(MODULE_PATH), `draai vitest vanuit agent-hub/ — niet gevonden: ${MODULE_PATH}`).toBe(true);
        const { readFileSync } = await import('node:fs');
        expect(readFileSync(MODULE_PATH, 'utf8')).not.toMatch(/^\s*import\s/m);
    });

    it('een kale datum staat in een NEGATIEVE offset op de juiste dag', () => {
        // De regressie: met `new Date(s)` staat de afspraak hier een dag te vroeg.
        expect(inZone('America/New_York', "m.parseWhen('2026-07-18').date.getDate()")).toBe(18);
        expect(inZone('America/New_York', "new Date('2026-07-18').getDate()")).toBe(17);
        expect(inZone('Pacific/Honolulu', "m.dateBlockParts('2026-07-18').day")).toBe('18');
    });

    it('en in een POSITIEVE offset ook — die zou de fout niet gevonden hebben', () => {
        expect(inZone('Europe/Amsterdam', "m.parseWhen('2026-07-18').date.getDate()")).toBe(18);
        expect(inZone('Europe/Amsterdam', "new Date('2026-07-18').getDate()")).toBe(18);
    });

    it('een datum MÉT tijd blijft een tijdstip en mag wél verschuiven', () => {
        expect(inZone('America/New_York', "m.parseWhen('2026-07-18T02:00:00Z').date.getDate()")).toBe(17);
        expect(inZone('America/New_York', "m.parseWhen('2026-07-18T02:00:00Z').dateOnly")).toBe(false);
    });
});
