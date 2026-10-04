/**
 * De agentkaart (A5 deel C).
 *
 * Vier dingen die op deze kaart mis kunnen gaan en die geen van alle uit een
 * screenshot blijken:
 *   1. de drie pillen met een NIET-ingevulde placeholder ("{count} tools");
 *   2. een onleesbare config die als drie nullen op het scherm komt;
 *   3. de prullenbak op een rij waarvan we het bewerkrecht niet weten;
 *   4. LIVE geplakt op `is_published` (het publiek) in plaats van op
 *      `published_version` (wat de runtime serveert).
 *
 * Run: cd agent-hub && ./node_modules/.bin/vitest run src/components/agents/AgentStudio/AgentCard.test.jsx
 */
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('../../../hooks/useTranslation', () => import('../../../test/useTranslationMock'));

import AgentCard from './AgentCard';

const t = (key, fallback) => (typeof fallback === 'string' ? fallback : key);

const CATS = [{ id: 'c1', name: 'Sales' }];

function draw(agent, props = {}) {
    return render(<ul><AgentCard t={t} agent={agent} categories={CATS} onOpen={() => {}} {...props} /></ul>);
}

afterEach(cleanup);

describe('de drie pillen', () => {
    it('tellen kennis, skills en tools uit de config, met het getal ingevuld', () => {
        draw({
            id: 'a1', name: 'Helpdesk', can_edit: true,
            config: {
                knowledge_base_ids: ['kb1', 'kb2'],
                attachedSkillIds: ['s1'],
                enabledIntegrations: ['gmail', 'agent-search'],
            },
        });
        const pills = screen.getByTestId('agent-card-counts').textContent;
        expect(pills).toContain('2 knowledge bases');
        expect(pills).toContain('1 skill');
        // "at least": deze agent heeft geen `config.tools.automations`, dus de
        // runtime legt er élke agent-callable automatisering van de vrager bovenop.
        expect(pills).toContain('at least 2 tools');
        // De placeholder is INGEVULD — een pil die "{count} tools" zegt is
        // erger dan geen pil (zelfde reden als `tx` in VisibilityCapsule).
        expect(pills).not.toContain('{count}');
    });

    it('enkelvoud en meervoud zijn twee sleutels, geen "(s)"', () => {
        draw({ id: 'a1', name: 'Solo', can_edit: true, config: { knowledge_base_ids: ['kb1'], attachedSkillIds: ['s1'] } });
        const pills = screen.getByTestId('agent-card-counts').textContent;
        expect(pills).toContain('1 knowledge base');
        expect(pills).not.toContain('1 knowledge bases');
        expect(pills).toContain('1 skill');
        expect(pills).not.toContain('1 skills');
        expect(pills).not.toContain('(s)');
    });

    it('een GECUREERDE agent krijgt een gewoon getal, geen ondergrens', () => {
        // De aanwezigheid van de sleutel `automations` is de curatie — spiegel
        // van `_curatedAutomations` in integrationTools.js.
        draw({
            id: 'a1', name: 'Curated', can_edit: true,
            config: { enabledIntegrations: ['gmail'], tools: { automations: {} } },
        });
        const pills = screen.getByTestId('agent-card-counts').textContent;
        expect(pills).toContain('1 tool');
        expect(pills).not.toContain('at least');
    });

    it('een `tools`-sectie die niet te lezen is krijgt woorden, geen getal', () => {
        draw({ id: 'a1', name: 'Kapot', can_edit: true, config: { tools: 'kapot', enabledIntegrations: ['gmail'] } });
        const pills = screen.getByTestId('agent-card-counts').textContent;
        expect(pills).toContain('Tools could not be read');
        expect(pills).not.toMatch(/\d+ tools?/);
    });
});

describe('leeg is niet onleesbaar', () => {
    it('nul kennisbanken is een gemeten nul: de pil zegt het, en verder niets', () => {
        // De gestippelde rij "No knowledge base" stond hier en is weg: dat was
        // een tweede lezing van een regel die op de server staat, en op één
        // kaart naast de voetregel die hetzelfde zegt. De PIL blijft — een
        // telling is geen bewering over gedrag.
        draw({ id: 'a1', name: 'Blanco', can_edit: true, config: { attachedSkillIds: ['s1'] } });
        expect(screen.queryByTestId('agent-card-no-knowledge')).toBeNull();
        expect(screen.getByTestId('agent-card-counts').textContent).toContain('0 knowledge bases');
    });

    it('de waarschuwing komt uit de VOET, en alleen op het woord van de server', () => {
        draw({
            id: 'a1', name: 'Los', can_edit: true, config: {},
            is_published: true, published_version: 0,
            stats: { conversationCount: 3, userCount: 1, othersConversationCount: 0 },
            grounding: { kb: false, tables: false, verdict: 'ungrounded' },
        });
        expect(screen.getByTestId('agent-card-footer').dataset.variant).toBe('ungrounded');
    });

    it('de server noemt hem grounded: de voet waarschuwt niet', () => {
        // Nul kennisbanken, maar een tabelgrant — de kaart mag de server niet
        // tegenspreken met een rood alarm.
        draw({
            id: 'a1', name: 'Tabel', can_edit: true, config: {},
            is_published: true, published_version: 0,
            stats: { conversationCount: 0, userCount: 0, othersConversationCount: 0 },
            grounding: { kb: false, tables: true, verdict: 'grounded' },
        });
        expect(screen.getByTestId('agent-card-footer').dataset.variant).not.toBe('ungrounded');
        expect(screen.getByTestId('agent-card-counts').textContent).toContain('0 knowledge bases');
    });

    it('een config die de server NIET kon lezen levert geen waarschuwing op', () => {
        // `verdict: null` is een derde waarde naast gegrond en ongegrond. De
        // oude client-regel viel hier terug op zijn eigen nul en zette er rood
        // alarm bij, terwijl Studio's Start-scherm dit als een GAT boekt.
        draw({
            id: 'a1', name: 'Half', can_edit: true, config: { knowledge_base_ids: 'kb-1' },
            is_published: true, published_version: 0,
            stats: { conversationCount: 0, userCount: 0, othersConversationCount: 0 },
            grounding: { kb: null, tables: false, verdict: null },
        });
        expect(screen.getByTestId('agent-card-footer').dataset.variant).not.toBe('ungrounded');
    });

    it('een onleesbare config geeft GEEN pillen', () => {
        draw({ id: 'a1', name: 'Onbekend', can_edit: true });
        expect(screen.queryByTestId('agent-card-counts')).toBeNull();
        expect(screen.getByTestId('agent-card-counts-unreadable')).toBeTruthy();
    });
});

describe('bewerkrecht — onbekend versmalt (BFSF-271)', () => {
    it('can_edit true: prullenbak, geen badge', () => {
        const onDelete = vi.fn();
        draw({ id: 'a1', name: 'Helpdesk', can_edit: true, config: {} }, { onDelete });
        fireEvent.click(screen.getByLabelText('Delete: Helpdesk'));
        expect(onDelete).toHaveBeenCalledTimes(1);
        expect(screen.queryByTestId('agent-card-view-only')).toBeNull();
        expect(screen.queryByTestId('agent-card-edit-unknown')).toBeNull();
    });

    it('can_edit false: "View only" en geen prullenbak', () => {
        draw({ id: 'a1', name: 'Helpdesk', can_edit: false, config: {} }, { onDelete: vi.fn() });
        expect(screen.getByTestId('agent-card-view-only').textContent).toBe('View only');
        expect(screen.queryByLabelText('Delete: Helpdesk')).toBeNull();
    });

    it('geen can_edit (/agents/system): geen prullenbak, en het zegt dat het onbekend is', () => {
        draw({ id: 'sys-1', name: 'Helpdesk', config: {} }, { onDelete: vi.fn() });
        expect(screen.queryByLabelText('Delete: Helpdesk')).toBeNull();
        // Niet "View only" — dat zou een antwoord zijn dat we niet hebben.
        expect(screen.queryByTestId('agent-card-view-only')).toBeNull();
        // De TEKST, niet alleen de testid: "Edit rights unknown" bestaat omdat
        // "View only" een antwoord zou zijn dat we niet hebben.
        expect(screen.getByTestId('agent-card-edit-unknown').textContent).toBe('Edit rights unknown');
    });
});

describe('de metaregel en de status', () => {
    it('LIVE hangt aan published_version, niet aan is_published', () => {
        draw({ id: 'a1', name: 'Gedeeld', can_edit: true, is_published: 1, published_version: 0, config: {} });
        expect(screen.getByTestId('agent-card-status').getAttribute('data-status')).toBe('draft');
        cleanup();
        draw({ id: 'a1', name: 'Live', can_edit: true, is_published: 0, published_version: 8, config: {} });
        expect(screen.getByTestId('agent-card-status').getAttribute('data-status')).toBe('live');
    });

    it('"Sales · v8 · Entire organisation" — categorie, versie, publiek', () => {
        draw({
            id: 'a1', name: 'Helpdesk', can_edit: true, category_id: 'c1',
            published_version: 8, is_published: 1, shared_groups: [], config: {},
        });
        const card = screen.getByTestId('agent-card').textContent;
        expect(card).toContain('Sales · v8 · Entire organisation');
    });

    it('een categorie die niet gelezen kon worden is niet "geen categorie"', () => {
        draw({ id: 'a1', name: 'Helpdesk', can_edit: true, category_id: 'verdwenen', config: {} });
        expect(screen.getByTestId('agent-card').textContent).toContain('Category unavailable');
    });

    it('zonder gepubliceerde versie staat er geen "v" in de metaregel', () => {
        draw({ id: 'a1', name: 'Concept', can_edit: true, category_id: 'c1', config: {} });
        expect(screen.getByTestId('agent-card').textContent).not.toContain('v0');
    });
});
