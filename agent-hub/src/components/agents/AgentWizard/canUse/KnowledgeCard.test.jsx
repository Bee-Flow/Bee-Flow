/**
 * De Kennis-kaart van "Kan gebruiken" (A2 stap 2).
 *
 * Wat hier vastligt: de ondertitels die het artboard belooft, en het verschil
 * tussen "er is niets" en "ik kon het niet lezen". Dat laatste is de reden dat
 * deze kaart bestaat in plaats van een lijstje: een agent met vijf
 * kennisbanken achter een 500 mag er nooit uitzien als een agent zonder
 * kennis.
 *
 * Run: cd agent-hub && npx vitest run src/components/agents/AgentWizard/canUse/KnowledgeCard.test.jsx
 */
import { render, screen, cleanup, fireEvent, within } from '@testing-library/react';
import { describe, it, expect, vi, afterEach } from 'vitest';

import { READ } from './canUseFacts';
import KnowledgeCard from './KnowledgeCard';
import { CHOOSER_SECTION } from './toolChooser';

const t = (key, fallback, params) => {
    let s = typeof fallback === 'string' ? fallback : key;
    for (const [k, v] of Object.entries(params || {})) s = s.split(`{${k}}`).join(String(v));
    return s;
};

const base = {
    t,
    rel: () => 'yesterday',
    kbRows: [],
    tableRows: [],
    onOpenChooser: () => {},
    onIncludeSourceReferencesChange: () => {},
};

const KB = { id: 'kb1', name: 'Quote terms', documentCount: 42, lastContentAt: '2026-09-06T10:00:00Z', readable: true };
const TABLE = { id: 't1', name: 'Quotes', scope: 'own', columns: '*', grantsNothing: false, readable: true };

afterEach(() => cleanup());

describe('KnowledgeCard — de kennisbankrij', () => {
    it('zegt "kennisbank · 42 documenten · bijgewerkt gisteren"', () => {
        render(<KnowledgeCard {...base} kbRows={[KB]} />);
        const row = screen.getByTestId('agent-knowledge-kb-row');
        expect(row.textContent).toContain('Quote terms');
        expect(row.textContent).toContain('knowledge base · 42 documents · updated yesterday');
    });

    it('gebruikt het enkelvoud bij één document', () => {
        render(<KnowledgeCard {...base} kbRows={[{ ...KB, documentCount: 1 }]} />);
        expect(screen.getByTestId('agent-knowledge-kb-row').textContent).toContain('1 document ·');
    });

    it('verzint geen "0 documenten" voor een kennisbank zonder teller', () => {
        render(<KnowledgeCard {...base} kbRows={[{ ...KB, documentCount: null, lastContentAt: null }]} />);
        const row = screen.getByTestId('agent-knowledge-kb-row');
        expect(row.textContent).toContain('knowledge base');
        expect(row.textContent).not.toContain('0 document');
        expect(row.textContent).not.toContain('updated');
    });

    it('houdt een onleesbare koppeling zichtbaar en zegt dat hij onleesbaar is', () => {
        render(<KnowledgeCard {...base} kbRows={[{ id: 'kb9', name: null, documentCount: null, lastContentAt: null, readable: false }]} />);
        const row = screen.getByTestId('agent-knowledge-kb-row');
        expect(row.textContent).toMatch(/could not be read/i);
        // En de kaart beweert NIET dat er niets gekoppeld is.
        expect(screen.queryByTestId('agent-knowledge-empty')).toBeNull();
    });
});

describe('KnowledgeCard — de tabelrij', () => {
    it('zegt "live · alleen eigen rijen van de vrager · leest, schrijft niet"', () => {
        render(<KnowledgeCard {...base} tableRows={[TABLE]} />);
        const row = screen.getByTestId('agent-knowledge-table-row');
        expect(row.textContent).toContain('Quotes');
        expect(row.textContent).toContain("live · only the asker's own rows · reads, does not write");
    });

    it('zegt "alle rijen" alleen bij scope all', () => {
        render(<KnowledgeCard {...base} tableRows={[{ ...TABLE, scope: 'all' }]} />);
        expect(screen.getByTestId('agent-knowledge-table-row').textContent).toContain('live · all rows · reads, does not write');
    });

    it('meldt een grant zonder kolommen als een weigering, niet als gewone rij', () => {
        render(<KnowledgeCard {...base} tableRows={[{ ...TABLE, columns: [], grantsNothing: true }]} />);
        expect(screen.getByTestId('agent-knowledge-table-row').textContent).toMatch(/No columns picked/i);
    });

    it('meldt tabellen die boven de runtime-grens vallen', () => {
        render(<KnowledgeCard {...base} tableRows={[TABLE]} tableTruncated={3} />);
        expect(screen.getByTestId('agent-knowledge-tables-truncated').textContent).toMatch(/3 more tables/);
    });
});

describe('KnowledgeCard — leeg is niet hetzelfde als onleesbaar', () => {
    it('zegt "niets gekoppeld" zodra de config nul koppelingen heeft — dat is geen lezing', () => {
        // Rijen komen uit de agentconfig, niet uit een fetch. Nul rijen is dus
        // een feit dat we vóór elke lezing al weten.
        const { rerender } = render(<KnowledgeCard {...base} />);
        expect(screen.getByTestId('agent-knowledge-empty')).toBeTruthy();
        rerender(<KnowledgeCard {...base} kbState={READ.LOADING} />);
        expect(screen.getByTestId('agent-knowledge-empty')).toBeTruthy();
    });

    it('waarschuwt niet over kennisbanken die deze agent niet heeft', () => {
        // Geen koppelingen: dan valt er ook niets te benoemen, en een
        // waarschuwing zou permanent staan.
        render(<KnowledgeCard {...base} kbState={READ.ERROR} tableState={READ.ERROR} />);
        expect(screen.queryByTestId('agent-knowledge-kbs-unreadable')).toBeNull();
        expect(screen.queryByTestId('agent-knowledge-tables-unreadable')).toBeNull();
    });

    it('noemt een rij die nog geladen wordt niet onleesbaar', () => {
        render(<KnowledgeCard {...base} kbState={READ.LOADING} kbRows={[{ id: 'kb1', name: null, documentCount: null, lastContentAt: null, readable: false }]} />);
        expect(screen.getByTestId('agent-knowledge-kb-row').textContent).not.toMatch(/could not be read/i);
        expect(screen.queryByTestId('agent-knowledge-kbs-unreadable')).toBeNull();
    });

    it('zegt bij een mislukte kennisbanklezing WAT er misging, en nooit "niets gekoppeld"', () => {
        const onRetryKbs = vi.fn();
        render(<KnowledgeCard {...base} kbState={READ.ERROR} onRetryKbs={onRetryKbs} kbRows={[{ id: 'kb1', name: null, documentCount: null, lastContentAt: null, readable: false }]} />);
        const notice = screen.getByTestId('agent-knowledge-kbs-unreadable');
        expect(notice.textContent).toMatch(/Could not load the knowledge bases/i);
        expect(screen.queryByTestId('agent-knowledge-empty')).toBeNull();
        fireEvent.click(within(notice).getByRole('button'));
        expect(onRetryKbs).toHaveBeenCalled();
    });

    it('meldt een mislukte tabellenlezing apart van de kennisbanken', () => {
        render(<KnowledgeCard {...base} tableState={READ.ERROR} tableRows={[{ ...TABLE, name: null, readable: false }]} />);
        expect(screen.getByTestId('agent-knowledge-tables-unreadable')).toBeTruthy();
        expect(screen.queryByTestId('agent-knowledge-kbs-unreadable')).toBeNull();
        expect(screen.queryByTestId('agent-knowledge-empty')).toBeNull();
    });
});

describe('KnowledgeCard — de knoppen', () => {
    it('"+ Koppelen" vraagt de kiezer om de sectie Kennisbanken', () => {
        const onOpenChooser = vi.fn();
        render(<KnowledgeCard {...base} onOpenChooser={onOpenChooser} />);
        fireEvent.click(screen.getByTestId('agent-knowledge-link'));
        expect(onOpenChooser).toHaveBeenCalledWith({ section: CHOOSER_SECTION.KNOWLEDGE_BASES, appId: null });
    });

    it('toont geen koppelknop bij alleen-lezen', () => {
        render(<KnowledgeCard {...base} ro />);
        expect(screen.queryByTestId('agent-knowledge-link')).toBeNull();
    });

    it('zet de bronverwijzingen in het ⋯-menu en geeft de wijziging door', () => {
        const onIncludeSourceReferencesChange = vi.fn();
        render(<KnowledgeCard {...base} onIncludeSourceReferencesChange={onIncludeSourceReferencesChange} />);
        // Dicht: de schakelaar staat er niet.
        expect(screen.queryByLabelText(/Include source references/i)).toBeNull();
        fireEvent.click(screen.getByTestId('agent-knowledge-menu'));
        const toggle = screen.getByRole('checkbox');
        fireEvent.click(toggle);
        expect(onIncludeSourceReferencesChange).toHaveBeenCalledWith(true);
    });
});

describe('KnowledgeCard — de tip over meeting notes', () => {
    it('staat er altijd en wijst naar de bronnen van de gekoppelde kennisbank', () => {
        const onNavigate = vi.fn();
        render(<KnowledgeCard {...base} kbRows={[KB]} onNavigate={onNavigate} tipKbId="kb1" />);
        const tip = screen.getByTestId('agent-knowledge-tip');
        expect(tip.textContent).toMatch(/meeting tag/i);
        fireEvent.click(screen.getByTestId('agent-knowledge-tip-action'));
        expect(onNavigate).toHaveBeenCalledWith('studio/knowledge/kb1/sources');
    });

    it('toont geen knop als er nergens heen genavigeerd kan worden', () => {
        render(<KnowledgeCard {...base} />);
        expect(screen.getByTestId('agent-knowledge-tip')).toBeTruthy();
        expect(screen.queryByTestId('agent-knowledge-tip-action')).toBeNull();
    });
});
