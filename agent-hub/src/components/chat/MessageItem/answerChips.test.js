// @vitest-environment node
import { describe, it, expect } from 'vitest';

import { answerChipsFor, citationChipsOf, ruleChipsOf, skillChipsOf, MAX_JUDGED_CHIPS, MAX_RECORDED_CHIPS } from './answerChips';

/**
 * Welke chips onder een antwoord mogen staan, en van welke soort bewering.
 *
 * De harde regels:
 *   • een skill die alleen AANSTOND heeft niets gedaan en krijgt geen chip;
 *   • een skill die we niet bij naam kennen ook niet — een id is geen bewering;
 *   • zonder attributie-event is er geen geoordeelde chip, in geen enkele vorm;
 *   • opgetekend en geoordeeld zitten in aparte lijsten, zodat de render ze
 *     nooit per ongeluk door elkaar kan zetten.
 */

const SKILLS = [
    { id: 's1', name: 'Offerte opstellen', icon: '📄' },
    { id: 's2', name: 'Prijs opzoeken', icon: '🔎' },
];

const msg = (over = {}) => ({ role: 'assistant', content: 'Dat regel ik.', ...over });

describe('citaten', () => {
    it('neemt kennisbankpassages en live tabelrijen mee — één event, één rij', () => {
        const out = citationChipsOf(msg({
            kbSources: [
                { title: 'Personeelshandboek', kind: 'kb_chunk', page: 12, content: 'x' },
                { title: 'Widget A', kind: 'datatable_row', datatableId: 't-1', rowId: 'r-7', sourceName: 'Producten', content: 'y' },
            ],
        }));
        expect(out.map(s => s.kind)).toEqual(['kb_chunk', 'datatable_row']);
    });

    it('laat een lege plek met een randje weg', () => {
        expect(citationChipsOf(msg({ kbSources: [{ title: '  ', content: '' }, null, {}] }))).toEqual([]);
        expect(citationChipsOf(msg({ kbSources: 'nope' }))).toEqual([]);
        expect(citationChipsOf(msg())).toEqual([]);
    });
});

describe('skills', () => {
    it('geeft een chip voor wat AFLIEP', () => {
        const out = skillChipsOf(msg({ sessionSkillsSnapshot: { completedSkillIds: ['s2'] } }), SKILLS);
        expect(out).toEqual([{ id: 's2', name: 'Prijs opzoeken', icon: '🔎' }]);
    });

    it('BIJT — een skill die alleen aanstond is geen herkomst', () => {
        // "Actief" betekent beschikbaar. Alleen wat afliep heeft aan dit
        // antwoord meegewerkt.
        const out = skillChipsOf(msg({ sessionSkillsSnapshot: { activatedSkillIds: ['s1', 's2'], completedSkillIds: [] } }), SKILLS);
        expect(out).toEqual([]);
    });

    it('BIJT — een voltooid id zonder naam levert geen chip met een id erin', () => {
        expect(skillChipsOf(msg({ sessionSkillsSnapshot: { completedSkillIds: ['s9'] } }), SKILLS)).toEqual([]);
        expect(skillChipsOf(msg({ sessionSkillsSnapshot: { completedSkillIds: ['s3'] } }), [...SKILLS, { id: 's3', name: '  ' }])).toEqual([]);
    });

    it('staat in de volgorde van de catalogus en ontdubbelt', () => {
        const out = skillChipsOf(msg({ sessionSkillsSnapshot: { completedSkillIds: ['s2', 's1', 's2'] } }), SKILLS);
        expect(out.map(s => s.id)).toEqual(['s1', 's2']);
    });

    it('zonder catalogus of zonder snapshot: niets, en geen fout', () => {
        expect(skillChipsOf(msg({ sessionSkillsSnapshot: { completedSkillIds: ['s1'] } }), null)).toEqual([]);
        expect(skillChipsOf(msg(), SKILLS)).toEqual([]);
        expect(skillChipsOf(null, SKILLS)).toEqual([]);
    });
});

describe('de geoordeelde chip', () => {
    it('toont de regel die de pass aanwees', () => {
        expect(ruleChipsOf(msg({ ruleAttribution: { rules: [{ rule: 'Nooit een prijs noemen' }] } })))
            .toEqual([{ rule: 'Nooit een prijs noemen' }]);
    });

    it('BIJT — zonder event is er geen chip, in geen enkele vorm', () => {
        // Niet "geen regel gevolgd", niet een lege pil: niets.
        for (const over of [{}, { ruleAttribution: null }, { ruleAttribution: {} },
            { ruleAttribution: { rules: [] } }, { ruleAttribution: { rules: 'ja' } },
            { ruleAttribution: { rules: [null, { rule: '   ' }, { rule: 42 }] } }]) {
            expect(ruleChipsOf(msg(over))).toEqual([]);
        }
    });

    it('ontdubbelt en begrenst', () => {
        const rules = Array.from({ length: MAX_JUDGED_CHIPS + 4 }, (_, i) => ({ rule: `regel ${i}` }));
        expect(ruleChipsOf(msg({ ruleAttribution: { rules } }))).toHaveLength(MAX_JUDGED_CHIPS);
        expect(ruleChipsOf(msg({ ruleAttribution: { rules: [{ rule: 'a' }, { rule: ' a ' }] } }))).toEqual([{ rule: 'a' }]);
    });
});

describe('de hele rij', () => {
    it('houdt opgetekend en geoordeeld gescheiden', () => {
        const out = answerChipsFor(msg({
            kbSources: [{ title: 'Handboek', content: 'x' }],
            sessionSkillsSnapshot: { completedSkillIds: ['s1'] },
            ruleAttribution: { rules: [{ rule: 'Nooit een prijs noemen' }] },
        }), { sessionSkills: SKILLS, showSources: true });

        expect(out.citations).toHaveLength(1);
        expect(out.skills).toHaveLength(1);
        expect(out.rules).toEqual([{ rule: 'Nooit een prijs noemen' }]);
        expect(out.hasRecorded).toBe(true);
        expect(out.hasJudged).toBe(true);
        expect(out.isEmpty).toBe(false);
    });

    it('een beurt zonder herkomst levert een lege rij', () => {
        const out = answerChipsFor(msg(), { sessionSkills: SKILLS, showSources: true });
        expect(out.isEmpty).toBe(true);
        expect(out.hasRecorded).toBe(false);
        expect(out.hasJudged).toBe(false);
    });

    it('alleen een oordeel is ook een rij — maar dan zonder opgetekende helft', () => {
        const out = answerChipsFor(msg({ ruleAttribution: { rules: [{ rule: 'Nooit medisch advies geven' }] } }), { showSources: true });
        expect(out.isEmpty).toBe(false);
        expect(out.hasRecorded).toBe(false);
        expect(out.hasJudged).toBe(true);
    });
});

describe('BIJT — de opgetekende helft is óók begrensd', () => {
    const citation = (i) => ({ kind: 'datatable_row', title: `Rij ${i}`, content: 'x' });

    it('vijftig tabelrijen worden geen muur van vijftig pillen', () => {
        // `kbSources` stapelt over alle toolrondes van één beurt, en één
        // `datatable_query` levert tot MAX_ROW_LIMIT = 50 citaten. De
        // geoordeelde helft stond al op zes; deze niet.
        const out = answerChipsFor({ kbSources: Array.from({ length: 50 }, (_, i) => citation(i)) }, { showSources: true });
        expect(out.citations).toHaveLength(MAX_RECORDED_CHIPS);
        expect(out.citationsHidden).toBe(50 - MAX_RECORDED_CHIPS);
    });

    it('wat er niet past wordt geteld, niet verzwegen', () => {
        const out = answerChipsFor({ kbSources: Array.from({ length: 7 }, (_, i) => citation(i)) }, { showSources: true });
        expect(out.citationsHidden).toBe(1);
    });

    it('en onder de grens verdwijnt er niets', () => {
        const out = answerChipsFor({ kbSources: [citation(1), citation(2)] }, { showSources: true });
        expect(out.citations).toHaveLength(2);
        expect(out.citationsHidden).toBe(0);
    });
});

describe('BIJT — de poort op kennisbankgegevens', () => {
    const msg = {
        kbSources: [{ kind: 'kb_chunk', title: 'Personeelshandboek', page: 12, content: 'x' }],
        ruleAttribution: { rules: [{ rule: 'Nooit een prijs noemen' }] },
    };

    it('zonder showSources staan er geen citaten', () => {
        const out = answerChipsFor(msg, { showSources: false });
        expect(out.citations).toEqual([]);
        expect(out.citationsHidden).toBe(0);
    });

    it('maar de regelchip blijft — die draagt geen documentgegevens', () => {
        const out = answerChipsFor(msg, { showSources: false });
        expect(out.rules).toHaveLength(1);
        expect(out.isEmpty).toBe(false);
    });

    it('onbekend versmalt: alles wat niet letterlijk true is, is geen toestemming', () => {
        for (const v of [undefined, null, 0, '', 'yes', 1, {}]) {
            expect(answerChipsFor(msg, { showSources: v }).citations).toEqual([]);
        }
        expect(answerChipsFor(msg, { showSources: true }).citations).toHaveLength(1);
    });
});

describe('BFSF-352: one chip per document, not per passage', () => {
    const passage = (over) => ({ kind: 'meeting', title: 'Weekly sync', content: 'x', ...over });

    it('three passages of one document are one chip that says so', () => {
        const out = citationChipsOf(msg({
            kbSources: [
                passage({ documentId: 'd-1', content: 'a', score: 0.2 }),
                passage({ documentId: 'd-1', content: 'b', score: 0.8 }),
                passage({ documentId: 'd-1', content: 'c', score: 0.5 }),
            ],
        }));
        expect(out).toHaveLength(1);
        expect(out[0].passageCount).toBe(3);
        expect(out[0].content).toBe('b');
    });

    it('two documents with the same title but another date stay two chips', () => {
        const out = citationChipsOf(msg({
            kbSources: [
                passage({ occurredAt: '2026-08-01T09:00:00Z' }),
                passage({ occurredAt: '2026-08-08T09:00:00Z' }),
            ],
        }));
        expect(out).toHaveLength(2);
        expect(out.every(s => s.passageCount === undefined)).toBe(true);
    });

    it('a snake_case project-KB source folds with a passage of the same document', () => {
        const out = citationChipsOf(msg({
            kbSources: [
                { title: 'Weekly sync', document_id: 'd-9', kb_id: 'kb-1', snippet: 's', score: 0.9 },
                passage({ documentId: 'd-9', content: 'full passage', score: 0.3 }),
            ],
        }));
        expect(out).toHaveLength(1);
        expect(out[0].passageCount).toBe(2);
        expect(out[0].content).toBe('full passage');
    });

    it('the cap and the "+N more" count documents', () => {
        const kbSources = [];
        for (let d = 0; d < 8; d++) {
            kbSources.push(passage({ documentId: `d-${d}` }), passage({ documentId: `d-${d}` }));
        }
        const out = answerChipsFor(msg({ kbSources }), { showSources: true });
        expect(out.citations).toHaveLength(MAX_RECORDED_CHIPS);
        expect(out.citationsHidden).toBe(8 - MAX_RECORDED_CHIPS);
    });
});
