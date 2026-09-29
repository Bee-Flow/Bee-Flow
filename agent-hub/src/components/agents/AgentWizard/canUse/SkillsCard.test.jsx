/**
 * De Skills-kaart van "Kan gebruiken" (A2 stap 2).
 *
 * De ondertitel van het artboard — "5 stappen · 3 regels · ook gebruikt door 2
 * andere agents" — plus de regel eronder: de gebruikstelling is een APARTE
 * lezing, en als die mislukt verdwijnt alleen de bijzin, met een zin die zegt
 * dat hij ontbreekt.
 *
 * Run: cd agent-hub && npx vitest run src/components/agents/AgentWizard/canUse/SkillsCard.test.jsx
 */
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, afterEach } from 'vitest';

import { READ } from './canUseFacts';
import SkillsCard from './SkillsCard';
import { CHOOSER_SECTION } from './toolChooser';

const t = (key, fallback, params) => {
    let s = typeof fallback === 'string' ? fallback : key;
    for (const [k, v] of Object.entries(params || {})) s = s.split(`{${k}}`).join(String(v));
    return s;
};

const base = { t, rows: [], onOpenChooser: () => {} };
const ROW = { id: 's1', name: 'Explain a quote', icon: '📄', stepCount: 5, ruleCount: 3, otherAgents: 2, readable: true };

afterEach(() => cleanup());

describe('SkillsCard — de rij', () => {
    it('zegt "5 stappen · 3 regels · ook gebruikt door 2 andere agents"', () => {
        render(<SkillsCard {...base} rows={[ROW]} />);
        const row = screen.getByTestId('agent-skill-row');
        expect(row.textContent).toContain('Explain a quote');
        expect(row.textContent).toContain('5 steps · 3 rules · also used by 2 other agents');
    });

    it('gebruikt de enkelvoudsleutels bij één', () => {
        render(<SkillsCard {...base} rows={[{ ...ROW, stepCount: 1, ruleCount: 1, otherAgents: 1 }]} />);
        expect(screen.getByTestId('agent-skill-row').textContent).toContain('1 step · 1 rule · also used by 1 other agent');
    });

    it('nul andere agents is een echte nul en wordt gezegd', () => {
        render(<SkillsCard {...base} rows={[{ ...ROW, otherAgents: 0 }]} />);
        expect(screen.getByTestId('agent-skill-row').textContent).toContain('also used by 0 other agents');
    });

    it('laat de bijzin weg als de gebruikstelling onbekend is, en zegt waarom', () => {
        render(<SkillsCard {...base} rows={[{ ...ROW, otherAgents: null }]} usageState={READ.ERROR} />);
        const row = screen.getByTestId('agent-skill-row');
        expect(row.textContent).toContain('5 steps · 3 rules');
        expect(row.textContent).not.toMatch(/also used by/);
        expect(screen.getByTestId('agent-skills-usage-unreadable').textContent).toMatch(/Could not read which other agents/i);
    });

    it('noemt een rij die nog geladen wordt niet onleesbaar', () => {
        render(<SkillsCard {...base} state={READ.LOADING} rows={[{ id: 's9', name: null, icon: null, stepCount: null, ruleCount: null, otherAgents: null, readable: false }]} />);
        expect(screen.getByTestId('agent-skill-row').textContent).not.toMatch(/could not be read/i);
        expect(screen.queryByTestId('agent-skills-partial')).toBeNull();
    });

    it('houdt een onleesbare skill zichtbaar in plaats van hem weg te laten', () => {
        render(<SkillsCard {...base} rows={[{ id: 's9', name: null, icon: null, stepCount: null, ruleCount: null, otherAgents: null, readable: false }]} />);
        expect(screen.getByTestId('agent-skill-row').textContent).toMatch(/could not be read/i);
        expect(screen.getByTestId('agent-skills-partial')).toBeTruthy();
        expect(screen.queryByTestId('agent-skills-empty')).toBeNull();
    });
});

describe('SkillsCard — leeg is niet hetzelfde als onleesbaar', () => {
    it('zegt "geen skills" alleen als de lezing gelukt is', () => {
        const { rerender } = render(<SkillsCard {...base} />);
        expect(screen.getByTestId('agent-skills-empty')).toBeTruthy();

        rerender(<SkillsCard {...base} state={READ.LOADING} />);
        expect(screen.queryByTestId('agent-skills-empty')).toBeNull();

        rerender(<SkillsCard {...base} state={READ.ERROR} />);
        expect(screen.queryByTestId('agent-skills-empty')).toBeNull();
        expect(screen.getByTestId('agent-skills-unreadable')).toBeTruthy();
    });

    it('laat een mislukte lezing opnieuw proberen', () => {
        const onRetry = vi.fn();
        render(<SkillsCard {...base} state={READ.ERROR} onRetry={onRetry} />);
        fireEvent.click(screen.getByText('Retry'));
        expect(onRetry).toHaveBeenCalled();
    });

    it('meldt de gebruiksfout niet als er geen rijen zijn om hem over te doen', () => {
        render(<SkillsCard {...base} usageState={READ.ERROR} />);
        expect(screen.queryByTestId('agent-skills-usage-unreadable')).toBeNull();
    });
});

describe('SkillsCard — de knoppen', () => {
    it('"+ Koppelen" vraagt de kiezer om de sectie Skills', () => {
        const onOpenChooser = vi.fn();
        render(<SkillsCard {...base} onOpenChooser={onOpenChooser} />);
        fireEvent.click(screen.getByTestId('agent-skills-link'));
        expect(onOpenChooser).toHaveBeenCalledWith({ section: CHOOSER_SECTION.SKILLS, appId: null });
    });

    it('toont geen koppelknop bij alleen-lezen', () => {
        render(<SkillsCard {...base} ro />);
        expect(screen.queryByTestId('agent-skills-link')).toBeNull();
    });
});
