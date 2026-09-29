import { render, screen } from '@testing-library/react';
import React from 'react';
import { describe, it, expect } from 'vitest';

import AnswerChips from './AnswerChips';
import MessageItem from './index';

/**
 * De chiprij onder een antwoord, en het enige dat er echt toe doet: dat een
 * GEOORDEELDE chip er niet uitziet als een OPGETEKENDE.
 *
 * Een kennisbankchip, een tabelrijchip en een skillchip komen van events die
 * de server schreef terwijl het antwoord gemaakt werd. "Regel gevolgd: …" komt
 * van een attributie-pass die achteraf de rol naast het antwoord legde. Als
 * die twee dezelfde pil dragen, leest iemand de mening met het gezag van de
 * notulen — en dan is de hele rij minder waard dan de sterkste chip erin.
 *
 * Dus wordt hier op de DRAGERS getest, niet op de kleur: de vorm (gestippeld),
 * de plaats (altijd achteraan), het kopje met de uitleg als toegankelijke
 * naam, en het feit dat er niets te klikken valt.
 */

const KB = { title: 'Personeelshandboek', kind: 'kb_chunk', page: 12, section: 'Verlof', content: 'Twee dagen vrij.' };
const ROW = {
    title: 'Widget A', kind: 'datatable_row', datatableId: 't-1', rowId: 'r-7',
    sourceName: 'Producten', section: 'Producten', content: 'prijs: 12,50',
};
const SKILLS = [{ id: 's1', name: 'Offerte opstellen', icon: '📄' }];

const msg = (over = {}) => ({ id: 'm-1', role: 'assistant', content: 'Dat regel ik.', ...over });

const chipsInOrder = (container) => [...container.querySelectorAll(
    '[data-testid="citation-chip"],[data-testid="skill-chip"],[data-testid="rule-chip"]',
)];

describe('de opgetekende helft', () => {
    it('citeert een kennisbankpassage met de plek erbij', () => {
        render(<AnswerChips showSources msg={msg({ kbSources: [KB] })} />);
        expect(screen.getByTestId('citation-chip').textContent).toBe('Personeelshandboek · p. 12');
    });

    it('een LIVE tabelrij is een eigen soort: het rijlabel plus zijn tabel', () => {
        // Zonder de tabelnaam is "Widget A" precies de kale chip waar het
        // paginanummer voor bestaat — niets om na te kijken.
        render(<AnswerChips showSources msg={msg({ kbSources: [ROW] })} />);
        expect(screen.getByTestId('citation-chip').textContent).toBe('Widget A · Producten');
    });

    it('BIJT — een tabelrij draagt de tabelglyph, niet die van een document', () => {
        const { container } = render(<AnswerChips showSources msg={msg({ kbSources: [KB, ROW] })} />);
        const [kb, row] = [...container.querySelectorAll('[data-testid="citation-chip"] svg')];
        expect(row.getAttribute('class')).toContain('lucide-table');
        expect(kb.getAttribute('class')).not.toContain('lucide-table');
    });

    it('BIJT — de tabelnaam wordt niet achter elke gewone passage geplakt', () => {
        // Alleen het paar datatableId+rowId maakt een chip een live rij. Op de
        // bronnaam afgaan zou "Nextcloud · /Sales" achter elke kb-chip zetten.
        render(<AnswerChips showSources msg={msg({ kbSources: [{ ...KB, sourceName: 'Nextcloud · /Sales' }] })} />);
        expect(screen.getByTestId('citation-chip').textContent).toBe('Personeelshandboek · p. 12');
    });

    it('noemt de tabel niet twee keer in de tooltip', () => {
        render(<AnswerChips showSources msg={msg({ kbSources: [ROW] })} />);
        expect(screen.getByTestId('citation-chip').getAttribute('title')).toBe('Widget A · Producten');
    });

    it('geeft een skill die afliep zijn eigen chip', () => {
        render(<AnswerChips showSources
            msg={msg({ sessionSkillsSnapshot: { completedSkillIds: ['s1'] } })}
            sessionSkills={SKILLS}
        />);
        expect(screen.getByTestId('skill-chip').textContent).toContain('Offerte opstellen');
    });
});

describe('de geoordeelde helft', () => {
    const judged = msg({ kbSources: [KB], ruleAttribution: { rules: [{ rule: 'Nooit een prijs noemen' }] } });

    it('noemt de regel die gevolgd is', () => {
        render(<AnswerChips showSources msg={judged} />);
        expect(screen.getByTestId('rule-chip').textContent).toBe('Rule followed: Nooit een prijs noemen');
    });

    it('BIJT — draagt een andere VORM dan een opgetekende chip, zonder kleur te gebruiken', () => {
        // Grijstinten moeten genoeg zijn: gestippeld tegen dicht.
        render(<AnswerChips showSources msg={judged} />);
        const rule = screen.getByTestId('rule-chip');
        const citation = screen.getByTestId('citation-chip');
        expect(rule.className).toContain('border-dashed');
        expect(citation.className).not.toContain('border-dashed');
        expect(rule.getAttribute('data-grade')).toBe('judged');
    });

    it('BIJT — staat ALTIJD achteraan, nooit tussen de opgetekende chips', () => {
        const { container } = render(<AnswerChips showSources
            msg={msg({
                kbSources: [KB, ROW],
                sessionSkillsSnapshot: { completedSkillIds: ['s1'] },
                ruleAttribution: { rules: [{ rule: 'Nooit een prijs noemen' }] },
            })}
            sessionSkills={SKILLS}
        />);
        const grades = chipsInOrder(container).map(el => el.getAttribute('data-testid'));
        expect(grades).toEqual(['citation-chip', 'citation-chip', 'skill-chip', 'rule-chip']);
    });

    it('BIJT — valt niet te klikken, want er is niets om achter te kijken', () => {
        render(<AnswerChips showSources msg={judged} />);
        expect(screen.getByTestId('rule-chip').tagName).toBe('SPAN');
        expect(screen.getByTestId('citation-chip').tagName).toBe('BUTTON');
    });

    it('BIJT — draagt geen glyph, want een glyph noemt het ding dat erachter zit', () => {
        render(<AnswerChips showSources msg={judged} />);
        expect(screen.getByTestId('rule-chip').querySelector('svg')).toBeNull();
        expect(screen.getByTestId('citation-chip').querySelector('svg')).toBeTruthy();
    });

    it('zegt in woorden wie het beweert — ook tegen een schermlezer', () => {
        render(<AnswerChips showSources msg={judged} />);
        expect(screen.getByTestId('judged-label').textContent).toBe('Judged');
        // De toegankelijke naam van de rij is de UITLEG, niet het kopje.
        const row = screen.getByRole('list', { name: /opinion, not something the run recorded/i });
        expect(row).toBeTruthy();
        expect(row.contains(screen.getByTestId('rule-chip'))).toBe(true);
    });
});

describe('als de attributie-pass omvalt', () => {
    it('BIJT — is er geen chip, en al helemaal niet één die "geen regel" beweert', () => {
        render(<AnswerChips showSources msg={msg({ kbSources: [KB], ruleAttribution: null })} />);
        expect(screen.queryByTestId('rule-chip')).toBeNull();
        expect(screen.queryByTestId('judged-label')).toBeNull();
        expect(screen.queryByText(/rule/i)).toBeNull();
        // De opgetekende helft staat er gewoon: één stille pass sloopt de rij niet.
        expect(screen.getByTestId('citation-chip')).toBeTruthy();
    });

    it('rendert helemaal niets voor een beurt zonder herkomst', () => {
        const { container } = render(<AnswerChips showSources msg={msg()} />);
        expect(container.firstChild).toBeNull();
    });
});

describe('de poort in MessageItem', () => {
    const withChips = msg({ kbSources: [KB], ruleAttribution: { rules: [{ rule: 'Nooit een prijs noemen' }] } });

    it('BIJT — de gewone chat krijgt de VERANTWOORDING niet ongevraagd', () => {
        // Sinds C6 staat de bronchip wél in de gewone chat: die hoort bij het
        // antwoord. Wat hier gepind blijft is de andere helft — de skills die
        // afliepen en de geoordeelde regel zijn de bouwersweergave, en die
        // hoort niet per ongeluk in een gewoon gesprek te verschijnen.
        render(<MessageItem idx={0} msg={withChips} allMessages={[withChips]} />);
        expect(screen.queryByTestId('rule-chip')).toBeNull();
        expect(screen.queryByTestId('judged-label')).toBeNull();
        expect(screen.queryByTestId('skill-chip')).toBeNull();
    });

    it('de testchat vraagt erom en krijgt hem', () => {
        render(<MessageItem idx={0} msg={withChips} allMessages={[withChips]} showAnswerChips />);
        expect(screen.getByTestId('answer-chips')).toBeTruthy();
        expect(screen.getByTestId('rule-chip').textContent).toContain('Nooit een prijs noemen');
    });

    it('een bericht van de gebruiker krijgt nooit chips', () => {
        const mine = { ...withChips, role: 'user' };
        render(<MessageItem idx={0} msg={mine} allMessages={[mine]} showAnswerChips />);
        expect(screen.queryByTestId('answer-chips')).toBeNull();
    });
});

describe('BIJT — de poort is fail-closed op de component zelf', () => {
    it('een aanroeper die showSources vergeet toont geen citaten', () => {
        // De invariant van HowIGotThisAnswer, hier onverkort: "a future caller
        // that forgets to thread the prop should print nothing rather than
        // everything". De productdefault (`true`) hoort op MessageItem.
        const { container } = render(<AnswerChips msg={msg({ kbSources: [KB] })} />);
        expect(container.textContent).not.toMatch(/Personeelshandboek/);
    });

    it('maar de geoordeelde chip blijft — die draagt geen documentgegevens', () => {
        render(<AnswerChips msg={msg({ ruleAttribution: { rules: [{ rule: 'Nooit een prijs noemen' }] } })} />);
        expect(screen.getAllByTestId('rule-chip')).toHaveLength(1);
    });
});

describe('BFSF-352: a document is one chip, and its label tells it apart', () => {
    const note = (over) => ({ kind: 'meeting', title: 'Automation meeting notes with a long title', content: 'x', ...over });

    it('several passages of one document render one chip with a count', () => {
        render(<AnswerChips showSources msg={msg({ kbSources: [
            note({ documentId: 'd-1', content: 'a' }),
            note({ documentId: 'd-1', content: 'b' }),
            note({ documentId: 'd-1', content: 'c' }),
        ] })} />);
        const chips = screen.getAllByTestId('citation-chip');
        expect(chips).toHaveLength(1);
        expect(screen.getByTestId('citation-chip-count').textContent).toBe('×3');
        expect(chips[0].getAttribute('aria-label')).toContain('3 passages from this document');
    });

    it('the date sits outside the truncated title, so two meetings read differently', () => {
        const { container } = render(<AnswerChips showSources msg={msg({ kbSources: [
            note({ occurredAt: '2026-08-01T09:00:00Z' }),
            note({ occurredAt: '2026-08-08T09:00:00Z' }),
        ] })} />);
        const chips = screen.getAllByTestId('citation-chip');
        expect(chips).toHaveLength(2);
        const truncated = [...container.querySelectorAll('[data-testid="citation-chip"] .truncate')];
        expect(truncated.map(el => el.textContent)).toEqual([
            'Automation meeting notes with a long title',
            'Automation meeting notes with a long title',
        ]);
        expect(chips[0].textContent).not.toBe(chips[1].textContent);
    });

    it('a folded chip drops the page, which belongs to one passage', () => {
        render(<AnswerChips showSources msg={msg({ kbSources: [
            { ...KB, documentId: 'd-2', page: 12 },
            { ...KB, documentId: 'd-2', page: 14, content: 'Another passage.' },
        ] })} />);
        expect(screen.getByTestId('citation-chip').textContent).toBe('Personeelshandboek×2');
    });
});
