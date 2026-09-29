import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import React from 'react';
import { Table2 } from 'lucide-react';
import StageShell, { StageHeader } from './StageShell';
import { heroCard, isBusy, panelCard, stagePadding, stageType, STAGE_BUTTON, WIDTH } from './stageChrome';
import { PHASE_VISUAL, phaseKind } from '../recipes';
import { KINDS } from '../phaseMachine';

const t = (_k, d, v) => (v ? Object.entries(v).reduce((s, [k, x]) => s.replace(`{${k}}`, x), d) : d);

/**
 * The drift test.
 *
 * Eight phase kinds were built in four rounds and each round brought its own
 * card recipe: four content widths (560 / full-bleed / 780 / 980), four outer
 * paddings, four header-tile recipes, four card radii and two primary-button
 * treatments in one film. This is what stops that list coming back.
 */
describe('the playbook stage vocabulary — one film, not four products', () => {
    it('every phase kind has a visual, and it names a real kind', () => {
        // A kind with no entry falls back to `playbook`, which is the rail's
        // colour — that is how a phase ends up a different colour on its stage
        // than in the rail beside it.
        for (const kind of KINDS) {
            expect(PHASE_VISUAL[kind], `no visual for kind "${kind}"`).toBeTruthy();
        }
        expect(phaseKind({ kind: 'design' })).toBe('app');
        expect(phaseKind({ key: 'approvals' })).toBe('automation');
        expect(phaseKind(null)).toBe('playbook');
    });

    it('there are two content widths, and `full` is declared rather than implied', () => {
        expect(WIDTH.narrow).toBe(560);
        expect(WIDTH.default).toBe(780);
        // `full` is null on purpose: the builders and the run canvas own their
        // own width, and saying so is different from forgetting to set one.
        expect(WIDTH.full).toBeNull();
    });

    it('one padding pair, one card radius per level, one button geometry', () => {
        expect(stagePadding(false)).toBe('24px');
        expect(stagePadding(true)).toBe('32px 32px');
        expect(heroCard(false).borderRadius).toBe(16);
        expect(panelCard(false).borderRadius).toBe(12);
        expect(heroCard(false).boxShadow).toBe('var(--shadow-md)');
        // Every button opts in to a ring: there is no global :focus-visible
        // baseline in this app.
        expect(STAGE_BUTTON).toContain('focus-visible:outline');
        expect(STAGE_BUTTON).toContain('h-8');
        expect(STAGE_BUTTON).toContain('rounded-[10px]');
    });

    it('presenter scales every step of the type ramp, not just the title', () => {
        const small = stageType(false);
        const big = stageType(true);
        for (const step of ['title', 'hero', 'card', 'body', 'meta', 'micro']) {
            expect(big[step], `${step} does not grow`).toBeGreaterThanOrEqual(small[step]);
        }
        // The one that was actually missed: the small type inside the design
        // wireframes stayed 11px on a projector.
        expect(big.meta).toBeGreaterThan(small.meta);
    });

    it('`ready` and `running` are the same half-second', () => {
        expect(isBusy('ready')).toBe(true);
        expect(isBusy('running')).toBe(true);
        expect(isBusy('awaiting')).toBe(false);
        expect(isBusy('failed')).toBe(false);
    });

    it('the shell announces its status line, which only one stage used to do', () => {
        const { getByTestId } = render(
            <StageShell kind="datatable" icon={Table2} title="Invoices" status="Creating the table…" testId="x">
                <p>body</p>
            </StageShell>,
        );
        const line = getByTestId('playbook-stage-status');
        expect(line.getAttribute('role')).toBe('status');
        expect(line.getAttribute('aria-live')).toBe('polite');
    });

    it('the header is an h2 wherever it is used, so the film has one heading level', () => {
        const shell = render(<StageShell kind="app" icon={Table2} title="A" testId="a"><i /></StageShell>);
        const bare = render(<StageHeader kind="app" icon={Table2} title="B" />);
        expect(shell.container.querySelector('h2')?.textContent).toBe('A');
        expect(bare.container.querySelector('h2')?.textContent).toBe('B');
        // Never an h1: the run page's own bar owns the document's title.
        expect(shell.container.querySelector('h1')).toBeNull();
    });

    it('a stage that passes no icon still renders — the shell never throws on a kind it has not met', () => {
        expect(() => render(<StageShell title={t('x', 'Untitled')} testId="y"><i /></StageShell>)).not.toThrow();
    });
});
