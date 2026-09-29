import { describe, it, expect } from 'vitest';
import { cardChrome } from '../../../automation/Builder/flow/nodeTypeColors';
import { KIND_KEYS, cardRadius, kindColorVar } from '../../../shared/kindColors';
import { STUDIO_APPS } from '../studioApps';
import {
    KINDS_OFF_MAP, MAP_BLOCKS, MAP_EDGES, MAP_H, MAP_KINDS, MAP_LANES, MAP_NODES, MAP_SYNTHETIC,
    MAP_W, TILE_H, TILE_W, VERB_LABEL, anchorOf, blockMeta, countState,
    edgeGeometries, edgeGeometry, edgeTouches, edgesOf, kindCardChrome, laneMeta,
    mapNode, syntheticCardChrome,
} from './studioMap';

/**
 * De kaart is HANDGELEGD. Dat is een bewuste keuze (zie de kop van
 * studioMap.js) en ze heeft één prijs: de plaat weet niet dat het product is
 * gegroeid. Deze test is die verdediging. De eerste beschrijving hieronder is
 * de belangrijkste van het hele bestand — zonder haar wordt de kaart op een
 * dag stilletjes onvolledig, en dat is precies de fout die niemand meldt
 * omdat er niets kapot gaat.
 */

describe('de kaart tegen het register', () => {
    it('tekent exact de soorten die kindColors kent — geen meer, geen minder', () => {
        // Beide richtingen, want ze falen om verschillende redenen:
        //   ontbreekt  → er is een elfde bouwsteen bij gekomen en die staat
        //                nergens op de plaat: herleg de kaart (coördinaten in
        //                MAP_BLOCKS, en kijk of de laanband nog past).
        //   te veel    → het register kent deze soort niet meer; haal hem van
        //                de kaart, inclusief zijn randen.
        // KINDS_OFF_MAP is de enige ontsnapping, en ze is met reden opgeschreven
        // in studioMap.js. Een soort die daar NIET in staat en hier ontbreekt,
        // is gewoon vergeten.
        const inMap = [...MAP_KINDS].sort();
        const inRegister = [...KIND_KEYS].filter((k) => !KINDS_OFF_MAP.includes(k)).sort();
        const missing = inRegister.filter((k) => !inMap.includes(k));
        const extra = inMap.filter((k) => !inRegister.includes(k));
        expect({ missing, extra }).toEqual({ missing: [], extra: [] });
        expect(inMap).toEqual(inRegister);
    });

    it('tekent elke soort precies één keer', () => {
        expect(new Set(MAP_KINDS).size).toBe(MAP_KINDS.length);
        expect(MAP_BLOCKS).toHaveLength(KIND_KEYS.length - KINDS_OFF_MAP.length);
        // Een vrijstelling die naar niets meer wijst is een vergeten opruiming.
        for (const k of KINDS_OFF_MAP) expect(KIND_KEYS).toContain(k);
    });

    it('kent van elke bouwsteen het label en de tellersleutel uit het register', () => {
        for (const block of MAP_BLOCKS) {
            const meta = blockMeta(block.kind);
            expect(meta, `geen Studio-sectie voor '${block.kind}'`).toBeTruthy();
            expect(typeof meta.labelKey).toBe('string');
            expect(meta.countKey).toBeTruthy();
        }
    });

    it('legt elke bouwsteen in de laan waar het register hem onder hangt', () => {
        // Zo kan een tegel niet onder "Bouwen" blijven liggen nadat de sectie
        // naar "AI" is verhuisd — de plaat en de rail zouden dan een ander
        // verhaal vertellen over hetzelfde ding.
        for (const block of MAP_BLOCKS) {
            expect(block.lane, `laan van '${block.kind}'`).toBe(blockMeta(block.kind).category);
        }
    });

    it('gebruikt alleen laan-ids die het register kent', () => {
        for (const lane of MAP_LANES) expect(laneMeta(lane.id), lane.id).toBeTruthy();
    });

    it('leidt de tellersleutel op dezelfde manier af als de rail (countKey || id)', () => {
        const railKeyFor = (kind) => {
            const app = STUDIO_APPS.find((a) => a.kind === kind);
            return app.countKey || app.id;
        };
        for (const block of MAP_BLOCKS) {
            expect(blockMeta(block.kind).countKey).toBe(railKeyFor(block.kind));
        }
    });
});

describe('de twaalf randen', () => {
    it('zijn er twaalf, met unieke ids', () => {
        expect(MAP_EDGES).toHaveLength(12);
        expect(new Set(MAP_EDGES.map((e) => e.id)).size).toBe(12);
    });

    it('wijzen alleen naar dozen die op de kaart staan', () => {
        for (const edge of MAP_EDGES) {
            expect(mapNode(edge.from), `bron van ${edge.id}`).toBeTruthy();
            expect(mapNode(edge.to), `doel van ${edge.id}`).toBeTruthy();
        }
    });

    it('dragen alleen werkwoorden uit het vocabulaire, met een zin erbij', () => {
        for (const edge of MAP_EDGES) {
            expect(edge.verbs.length).toBeGreaterThan(0);
            for (const verb of edge.verbs) expect(VERB_LABEL[verb], verb).toBeTruthy();
            expect(edge.labelKey.startsWith('studio.map.')).toBe(true);
            expect(edge.labelFallback.length).toBeGreaterThan(10);
        }
    });

    it('dragen hun sleutel in de huisvorm, zodat de i18n-guard ze ziet', () => {
        // `labelKey` + `labelFallback` is de vorm die src/i18n/i18nGuard.test.js
        // als DRAGER herkent (CARRIERS). Een eigen naam als `sentenceKey` zou
        // werken en toch onzichtbaar zijn voor de guard: elf sleutels die
        // niemand ooit mist. Dat is precies de stille schuld die dat bestand
        // bestaat om te voorkomen.
        for (const [verb, label] of Object.entries(VERB_LABEL)) {
            expect(label.labelKey, verb).toBe(`studio.map.verb_${verb}`);
            expect(typeof label.labelFallback, verb).toBe('string');
        }
        for (const node of MAP_SYNTHETIC) expect(node.labelKey.startsWith('studio.map.')).toBe(true);
    });

    it('houden lezen en schrijven apart op de tabel-rand', () => {
        const edge = MAP_EDGES.find((e) => e.id === 'automation-datatable');
        expect(edge.verbs).toEqual(['reads', 'writes']);
    });

    it('raken de goedkeuring twee keer, en die is geen bouwsteen', () => {
        expect(edgesOf('approval').map((e) => e.from).sort()).toEqual(['app', 'automation']);
        expect(MAP_SYNTHETIC.every((n) => n.synthetic && n.kind === null)).toBe(true);
        expect(MAP_KINDS).not.toContain('approval');
    });

    it('laten een oplossing los staan — een container wijst nergens heen', () => {
        expect(edgesOf('solution')).toEqual([]);
    });

    it('tellen een zelflus één keer voor de doos die hem draagt', () => {
        const self = MAP_EDGES.find((e) => e.id === 'automation-calls-automation');
        expect(self.from).toBe(self.to);
        expect(edgesOf('automation').filter((e) => e.id === self.id)).toHaveLength(1);
        expect(edgeTouches(self, 'automation')).toBe(true);
        expect(edgeTouches(self, 'app')).toBe(false);
    });
});

describe('de meetkunde', () => {
    it('geeft elke rand een pad, een pijlpunt en een labelpunt binnen de plaat', () => {
        const geoms = edgeGeometries();
        expect(geoms).toHaveLength(MAP_EDGES.length);
        for (const { edge, geometry } of geoms) {
            expect(geometry.d.startsWith('M '), edge.id).toBe(true);
            expect(geometry.d).not.toMatch(/NaN|undefined/);
            expect(geometry.arrow.endsWith('Z'), edge.id).toBe(true);
            expect(geometry.arrow).not.toMatch(/NaN|undefined/);
            expect(geometry.mid.x).toBeGreaterThan(0);
            expect(geometry.mid.x).toBeLessThan(MAP_W);
            expect(geometry.mid.y).toBeGreaterThan(0);
            expect(geometry.mid.y).toBeLessThan(MAP_H);
        }
    });

    it('begint en eindigt elke rand op de rand van de juiste doos', () => {
        const edge = MAP_EDGES.find((e) => e.id === 'meeting-feeds-kb');
        const start = anchorOf(mapNode('meeting'), 'right');
        const end = anchorOf(mapNode('kb'), 'left');
        const d = edgeGeometry(edge).d;
        expect(d.startsWith(`M ${start.x} ${start.y}`)).toBe(true);
        expect(d.endsWith(`${end.x} ${end.y}`)).toBe(true);
    });

    it('stuurt de app→tabel-rand om de routine heen, langs de opgegeven knikken', () => {
        // De enige rand met een handgelegde omweg: onderlangs, dan door de
        // gang tussen kolom b en c omhoog. Als een van die knikken wegvalt
        // loopt de lijn dwars door de routine-tegel.
        const d = edgeGeometry(MAP_EDGES.find((e) => e.id === 'app-uses-datatable')).d;
        expect(d).toContain('224');
        expect(d).toContain('459');
        expect(d).toMatch(/Q/);
    });

    it('laat geen enkele rand dwars door een vreemde doos lopen', () => {
        // De enige fout die een HANDGELEGDE kaart echt maakt: een lijn die over
        // een tegel heen loopt. Geen enkele assertie op ids vangt dat, dus dit
        // rekent het pad na. Bemonsterd, niet exact: een bezier heeft geen
        // gesloten snijpuntformule tegen een rechthoek, en 60 punten over een
        // pad van hooguit 400px is elke 7px een controle.
        const samples = (d) => {
            const nums = d.match(/-?\d+(?:\.\d+)?/g).map(Number);
            const pts = [];
            for (let i = 0; i + 1 < nums.length; i += 2) pts.push({ x: nums[i], y: nums[i + 1] });
            if (/ C /.test(d) && pts.length === 4) {
                const [p0, p1, p2, p3] = pts;
                return Array.from({ length: 61 }, (_, i) => {
                    const u = i / 60;
                    const v = 1 - u;
                    return {
                        x: v ** 3 * p0.x + 3 * v * v * u * p1.x + 3 * v * u * u * p2.x + u ** 3 * p3.x,
                        y: v ** 3 * p0.y + 3 * v * v * u * p1.y + 3 * v * u * u * p2.y + u ** 3 * p3.y,
                    };
                });
            }
            // Een omweg: recht van hoekpunt naar hoekpunt (de afronding ligt
            // binnen 8px van de hoek, dus dit is de route zelf).
            const out = [];
            for (let i = 1; i < pts.length; i += 1) {
                for (let k = 0; k <= 20; k += 1) {
                    out.push({
                        x: pts[i - 1].x + (pts[i].x - pts[i - 1].x) * (k / 20),
                        y: pts[i - 1].y + (pts[i].y - pts[i - 1].y) * (k / 20),
                    });
                }
            }
            return out;
        };
        const hits = [];
        for (const { edge, geometry } of edgeGeometries()) {
            for (const p of samples(geometry.d)) {
                for (const node of MAP_NODES) {
                    if (node.id === edge.from || node.id === edge.to) continue;
                    const inside = p.x > node.x + 1 && p.x < node.x + TILE_W - 1
                        && p.y > node.y + 1 && p.y < node.y + TILE_H - 1;
                    if (inside) hits.push(`${edge.id} loopt door ${node.id}`);
                }
            }
        }
        expect([...new Set(hits)]).toEqual([]);
    });

    it('houdt elke doos binnen de band van haar eigen laan', () => {
        for (const node of MAP_NODES) {
            const lane = MAP_LANES.find((l) => l.id === node.lane);
            expect(lane, node.id).toBeTruthy();
            expect(node.y, `${node.id} boven zijn laan`).toBeGreaterThanOrEqual(lane.y);
            expect(node.y + TILE_H, `${node.id} onder zijn laan`).toBeLessThanOrEqual(lane.y + lane.h);
            expect(node.x).toBeGreaterThanOrEqual(8);
            expect(node.x + TILE_W).toBeLessThanOrEqual(MAP_W - 8);
        }
    });

    it('laat geen twee dozen over elkaar heen liggen', () => {
        for (let i = 0; i < MAP_NODES.length; i += 1) {
            for (let j = i + 1; j < MAP_NODES.length; j += 1) {
                const a = MAP_NODES[i];
                const b = MAP_NODES[j];
                const overlap = a.x < b.x + TILE_W && b.x < a.x + TILE_W
                    && a.y < b.y + TILE_H && b.y < a.y + TILE_H;
                expect(overlap, `${a.id} overlapt ${b.id}`).toBe(false);
            }
        }
    });

    it('houdt de lanen uit elkaar en binnen de plaat', () => {
        let prevBottom = 0;
        for (const lane of MAP_LANES) {
            expect(lane.y).toBeGreaterThanOrEqual(prevBottom);
            prevBottom = lane.y + lane.h;
        }
        expect(prevBottom).toBeLessThanOrEqual(MAP_H);
    });
});

describe('de tegel-chrome', () => {
    it('is het recept van de canvas-kaart, met de kleur en de vorm van de soort', () => {
        const chrome = kindCardChrome('kb');
        const base = cardChrome({ group: null });
        const layers = chrome.boxShadow.split(', ');
        // Laag 0 is de familiebalk, en die draagt hier de KIND-kleur.
        expect(layers[0]).toBe(`inset 4px 0 0 ${kindColorVar('kb')}`);
        expect(layers[0]).not.toContain('text-tertiary');
        // De rest van het recept blijft ongemoeid — schaduw, rand, dekking.
        expect(layers.slice(1).join(', ')).toBe(base.style.boxShadow.split(', ').slice(1).join(', '));
        expect(chrome.border).toBe(base.style.border);
        expect(chrome.opacity).toBe(base.style.opacity);
    });

    it('neemt de vorm van kindColors over, niet die van een stapfamilie', () => {
        expect(kindCardChrome('automation').borderRadius).toBe(cardRadius('automation'));
        expect(kindCardChrome('automation').borderRadius).not.toBe(cardChrome({ group: null }).style.borderRadius);
        expect(kindCardChrome('kb').borderRadius).toBe(cardRadius('kb'));
    });

    it('laat de selectiering van het recept staan', () => {
        const plain = kindCardChrome('app');
        const selected = kindCardChrome('app', { selected: true });
        expect(selected.border).toBe('2px solid var(--text-primary)');
        expect(selected.boxShadow.split(', ').length).toBeGreaterThan(plain.boxShadow.split(', ').length);
        expect(selected.boxShadow).toContain('var(--text-primary) 14%');
        // en nog steeds de eigen kleur op de balk
        expect(selected.boxShadow.split(', ')[0]).toBe(`inset 4px 0 0 ${kindColorVar('app')}`);
    });

    it('dempt een tegel die buiten de selectie valt', () => {
        expect(kindCardChrome('app', { dimmed: true }).opacity).toBeLessThan(1);
    });

    it('tekent de synthetische doos gestippeld, maar leesbaar zodra ze gekozen is', () => {
        const plain = syntheticCardChrome();
        expect(plain.border).toContain('dashed');
        expect(plain.opacity).toBeLessThan(1);
        expect(syntheticCardChrome({ selected: true }).opacity).toBe(1);
    });
});

describe('countState', () => {
    it('kent vier toestanden en haalt "leeg" en "onleesbaar" niet door elkaar', () => {
        const kb = mapNode('kb');
        expect(countState(kb, null)).toEqual({ state: 'pending' });
        expect(countState(kb, {})).toEqual({ state: 'unknown' });
        expect(countState(kb, { knowledge: 0 })).toEqual({ state: 'known', value: 0 });
        expect(countState(kb, { knowledge: 7 })).toEqual({ state: 'known', value: 7 });
        expect(countState(mapNode('approval'), { knowledge: 7 })).toEqual({ state: 'not_counted' });
    });

    it('leest rommel niet als een getal', () => {
        const kb = mapNode('kb');
        for (const junk of [{ knowledge: null }, { knowledge: '3' }, { knowledge: NaN }, { knowledge: undefined }]) {
            expect(countState(kb, junk), JSON.stringify(junk)).toEqual({ state: 'unknown' });
        }
    });
});
