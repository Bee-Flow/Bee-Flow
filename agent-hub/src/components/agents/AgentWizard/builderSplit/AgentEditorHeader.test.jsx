/**
 * De kop van de agent-editor (A2 stap 1).
 *
 * Wat hier vastgepind wordt, is precies wat een volgende stage per ongeluk
 * kan omdraaien:
 *   - de BEWUSTE AFWIJKING: in de kindtegel staat het AVATAR van de agent,
 *     niet de lucide-bot van het artboard — en zonder avatar valt hij wél
 *     terug op die bot;
 *   - LIVE vs CONCEPT hangt aan `published_version`, niet aan `is_published`
 *     (dat is het andere publiceer-werkwoord, de capsule ernaast);
 *   - een teller die niet gelezen kon worden toont GEEN 0;
 *   - alleen-lezen haalt de bewerkende affordances weg maar laat terug en
 *     de tabs staan.
 *
 * Run: cd agent-hub && npx vitest run src/components/agents/AgentWizard/builderSplit/AgentEditorHeader.test.jsx
 */
import { render, screen, cleanup, within } from '@testing-library/react';
import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('../../../../utils/helpers', () => ({
    API_BASE: '',
    authFetch: vi.fn(async () => ({ ok: false, json: async () => ({}), text: async () => '' })),
}));
vi.mock('../../../../hooks/useTranslation', () => import('../../../../test/useTranslationMock'));

import AgentEditorHeader, { AGENT_TAB_IDS, buildAgentTabs, countOrNothing, publishedVersionOf } from './AgentEditorHeader';

const t = (key, fallback) => (typeof fallback === 'string' ? fallback : key);

const baseProps = {
    t,
    agent: { id: 'a1', name: 'Test Agent' },
    name: 'Test Agent',
    avatar: '🐝',
    onBack: () => {},
    onRename: () => {},
    tabs: buildAgentTabs(t, {}),
    activeTab: AGENT_TAB_IDS.ROLE,
    onTab: () => {},
    savingState: 'idle',
    savedAt: null,
    saveErrorMsg: '',
    onRetrySave: () => {},
    saveDraft: () => {},
    publishedVersion: 0,
    onPublishVersion: () => {},
};

afterEach(() => cleanup());

describe('AgentEditorHeader — de tegel houdt het avatar (afwijking van het ontwerp)', () => {
    it('zet de emoji van de agent in de kindtegel', () => {
        render(<AgentEditorHeader {...baseProps} />);
        const tile = screen.getByTestId('studio-section-kind');
        expect(tile.getAttribute('data-kind')).toBe('agent');
        expect(within(tile).getByTestId('agent-tile-avatar').textContent).toBe('🐝');
    });

    it('valt zonder avatar terug op de glyph van kindColors', () => {
        render(<AgentEditorHeader {...baseProps} avatar={null} />);
        const tile = screen.getByTestId('studio-section-kind');
        expect(within(tile).queryByTestId('agent-tile-avatar')).toBeNull();
        expect(tile.querySelector('svg')).toBeTruthy();
    });
});

describe('AgentEditorHeader — LIVE / CONCEPT hangt aan published_version', () => {
    it('een agent zonder gepubliceerde versie is CONCEPT en biedt "Publish"', () => {
        render(<AgentEditorHeader {...baseProps} publishedVersion={0} />);
        const pill = screen.getByTestId('agent-publish-pill');
        expect(pill.getAttribute('data-status')).toBe('draft');
        expect(within(pill).getByRole('button').textContent).toContain('Publish');
        expect(within(pill).getByRole('button').textContent).not.toContain('new version');
        // Geen versie ⇒ geen versiechip; "v0" zou een versie verzinnen.
        expect(screen.queryByTestId('agent-version-chip')).toBeNull();
    });

    it('een gepubliceerde agent is LIVE, toont "Saved · v8" en biedt een nieuwe versie', () => {
        render(<AgentEditorHeader {...baseProps} publishedVersion={8} />);
        const pill = screen.getByTestId('agent-publish-pill');
        expect(pill.getAttribute('data-status')).toBe('live');
        expect(within(pill).getByRole('button').textContent).toContain('Publish new version');
        expect(screen.getByTestId('agent-version-chip').textContent).toBe('Saved · v8');
    });

    it('leest de publiek-vlag NIET als een gepubliceerde versie', () => {
        // is_published = het andere werkwoord (wie mag dit zien). Een agent die
        // gedeeld is maar nooit gepubliceerd, draait nog het concept.
        render(<AgentEditorHeader {...baseProps} agent={{ id: 'a1', is_published: 1 }} publishedVersion={publishedVersionOf({ id: 'a1', is_published: 1 })} />);
        expect(screen.getByTestId('agent-publish-pill').getAttribute('data-status')).toBe('draft');
    });
});

describe('AgentEditorHeader — alleen-lezen', () => {
    it('haalt publiceren en hernoemen weg maar laat terug en de tabs staan', () => {
        render(<AgentEditorHeader {...baseProps} ro publishedVersion={3} />);
        expect(screen.queryByTestId('agent-publish-pill')).toBeNull();
        expect(screen.queryByTestId('agent-save-draft')).toBeNull();
        // De naam is een kop, geen hernoemknop.
        expect(screen.getByTestId('studio-section-title').tagName).toBe('H1');
        // Terug en de tabstrip blijven bedienbaar.
        expect(screen.getByTestId('studio-section-back')).toBeTruthy();
        expect(screen.getAllByRole('radio').length).toBe(4);
        expect(screen.getByTestId('agent-readonly-chip')).toBeTruthy();
        // De capsule staat er wel, maar is dicht.
        expect(screen.getByTestId('visibility-capsule').disabled).toBe(true);
    });

    it('een concept zonder id toont de expliciete eerste opslag in plaats van de split-knop', () => {
        render(<AgentEditorHeader {...baseProps} agent={{ id: null }} />);
        expect(screen.queryByTestId('agent-publish-pill')).toBeNull();
        expect(screen.getByTestId('agent-save-draft')).toBeTruthy();
        // Zonder id valt er niets te delen: geen capsule.
        expect(screen.queryByTestId('visibility-capsule')).toBeNull();
    });
});

describe('buildAgentTabs — een teller die niet gelezen kon worden toont geen 0', () => {
    it('laat een onbekende teller weg en houdt een gemeten 0 vast', () => {
        const tabs = buildAgentTabs(t, { canUseCount: undefined, usedByCount: 0 });
        expect(tabs.map(x => x.id)).toEqual(['role', 'can-use', 'test', 'used-by']);
        expect(tabs[1].count).toBeUndefined();
        expect(tabs[3].count).toBe(0);
    });

    it('countOrNothing weigert alles wat geen eindig getal is', () => {
        expect(countOrNothing(0)).toBe(0);
        expect(countOrNothing(7)).toBe(7);
        expect(countOrNothing(undefined)).toBeUndefined();
        expect(countOrNothing(null)).toBeUndefined();
        expect(countOrNothing(NaN)).toBeUndefined();
        expect(countOrNothing('3')).toBeUndefined();
    });

    it('rendert de onbekende teller ook echt niet als 0', () => {
        render(<AgentEditorHeader {...baseProps} tabs={buildAgentTabs(t, { canUseCount: undefined, usedByCount: 2 })} />);
        const strip = screen.getByRole('radiogroup');
        expect(within(strip).getByText('2')).toBeTruthy();
        expect(within(strip).queryByText('0')).toBeNull();
    });
});

describe('publishedVersionOf', () => {
    it('leest beide schrijfwijzen en weigert wat geen versie is', () => {
        expect(publishedVersionOf({ published_version: 4 })).toBe(4);
        expect(publishedVersionOf({ publishedVersion: '9' })).toBe(9);
        expect(publishedVersionOf({ published_version: 0 })).toBe(0);
        expect(publishedVersionOf({ published_version: null })).toBe(0);
        expect(publishedVersionOf({ published_version: 'oops' })).toBe(0);
        expect(publishedVersionOf(null)).toBe(0);
    });
});
