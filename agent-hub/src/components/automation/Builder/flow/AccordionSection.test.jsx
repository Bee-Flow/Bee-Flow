import { render, screen, cleanup } from '@testing-library/react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import AccordionSection from './AccordionSection';
import { FormDensityContext, densityForOpen } from './settings/formDensity';
import scopedStorage from '../../../../utils/scopedStorage';

/**
 * The quick editor's whole promise is "only what you need". That rule lives in
 * one place (formDensity.js) and is enforced here, so a new section can't leak
 * into the quick view by accident — or, worse, hide a validation error.
 */
function renderAt(density, props = {}, onHiddenSection = null) {
    return render(
        <FormDensityContext.Provider value={{ density, onHiddenSection }}>
            <AccordionSection stepType="ai_step" sectionKey="advanced" title="Advanced" {...props}>
                <div>secret setting</div>
            </AccordionSection>
        </FormDensityContext.Provider>,
    );
}

describe('AccordionSection density', () => {
    beforeEach(() => {
        cleanup();
        scopedStorage.setCurrentUser('accordion-test-user');
        try { localStorage.clear(); } catch { /* ignore */ }
    });

    it('renders an advanced section in the full view', () => {
        renderAt('full');
        expect(screen.getByText('secret setting')).toBeTruthy();
    });

    it('leaves it out entirely in the quick view', () => {
        renderAt('quick');
        expect(screen.queryByText('secret setting')).toBeNull();
    });

    it('keeps a primary section in BOTH views', () => {
        const primary = (density) => render(
            <FormDensityContext.Provider value={{ density }}>
                <AccordionSection stepType="ai_step" sectionKey="inputs" title="Inputs"><div /></AccordionSection>
            </FormDensityContext.Provider>,
        );
        primary('quick');
        expect(screen.getByText('Inputs')).toBeTruthy();
        cleanup();
        primary('full');
        expect(screen.getByText('Inputs')).toBeTruthy();
    });

    it('shows an advanced section anyway when it holds a validation error', () => {
        // An error the user cannot reach is worse than a busy panel.
        renderAt('quick', { forceOpen: true });
        expect(screen.getByText('secret setting')).toBeTruthy();
    });

    it('reports what it hid so the host can count it', () => {
        const onHiddenSection = vi.fn();
        renderAt('quick', {}, onHiddenSection);
        expect(onHiddenSection).toHaveBeenCalledWith('advanced');
    });

    it('defaults to the full view when no density context is present', () => {
        render(
            <AccordionSection stepType="ai_step" sectionKey="advanced" title="Advanced"><div>secret setting</div></AccordionSection>,
        );
        expect(screen.getByText('secret setting')).toBeTruthy();
    });
});

describe('densityForOpen', () => {
    it('reopens at the remembered density; a double click still forces the full view', () => {
        // A single click asks for nothing → the density the drawer was left
        // in (quick when nothing is remembered yet). Only an explicit 'full'
        // (the double click) overrides the memory. User request 2026-09-03:
        // "open it how I opened it before".
        expect(densityForOpen(undefined)).toBe('quick');
        expect(densityForOpen(null)).toBe('quick');
        expect(densityForOpen('quick')).toBe('quick');
        expect(densityForOpen('full')).toBe('full');
        expect(densityForOpen('nonsense')).toBe('quick');
        expect(densityForOpen(undefined, 'full')).toBe('full');
        expect(densityForOpen('quick', 'full')).toBe('full');
        expect(densityForOpen(undefined, 'quick')).toBe('quick');
        expect(densityForOpen('full', 'quick')).toBe('full');
        expect(densityForOpen(undefined, 'nonsense')).toBe('quick');
    });
});

describe('AccordionSection mode (Simple / Advanced)', () => {
    beforeEach(() => {
        cleanup();
        scopedStorage.setCurrentUser('accordion-test-user');
        try { localStorage.clear(); } catch { /* ignore */ }
    });

    const renderWith = (ctx, props = {}) => render(
        <FormDensityContext.Provider value={ctx}>
            <AccordionSection stepType="ai_step" sectionKey="advanced" title="Advanced" {...props}>
                <div>secret setting</div>
            </AccordionSection>
        </FormDensityContext.Provider>,
    );

    it('the user\'s mode beats the gesture, in BOTH directions', () => {
        // Advanced mode shows the section even in the small (quick) window…
        renderWith({ density: 'quick', mode: 'advanced' });
        expect(screen.getByText('secret setting')).toBeTruthy();
        cleanup();
        // …and Simple hides it even in the big (full) window.
        renderWith({ density: 'full', mode: 'simple' });
        expect(screen.queryByText('secret setting')).toBeNull();
    });

    it('a configured section is never hidden in Simple, and says why', () => {
        const ui = (
            <FormDensityContext.Provider value={{ density: 'quick', mode: 'simple' }}>
                <AccordionSection stepType="ai_step" sectionKey="output" title="Output" hasContent>
                    <div>secret setting</div>
                </AccordionSection>
            </FormDensityContext.Provider>
        );
        render(ui);
        expect(screen.getByText('Output')).toBeTruthy();
        // The "set" badge marks it as kept-because-configured.
        expect(screen.getByText('set')).toBeTruthy();
    });

    it('Advanced is the mode, not a section: out of Simple even when it holds settings', () => {
        renderWith({ density: 'full', mode: 'simple' }, { hasContent: true });
        expect(screen.queryByText('secret setting')).toBeNull();
        expect(screen.queryByText('set')).toBeNull();
    });

    it('a section revealed by Simple → Advanced arrives OPEN', () => {
        const ui = (mode) => (
            <FormDensityContext.Provider value={{ density: 'quick', mode }}>
                <AccordionSection stepType="ai_step" sectionKey="output" title="Output">
                    <div>secret setting</div>
                </AccordionSection>
            </FormDensityContext.Provider>
        );
        const { rerender } = render(ui('simple'));
        expect(screen.queryByText('secret setting')).toBeNull();
        rerender(ui('advanced'));
        // Not merely present — OPEN. Revealing it collapsed would make the
        // toggle look like it did nothing.
        expect(screen.getByText('secret setting')).toBeTruthy();
    });

    it('in the Advanced mode its settings are simply there: no band, no toggle', () => {
        const ui = (mode) => (
            <FormDensityContext.Provider value={{ density: 'quick', mode }}>
                <AccordionSection stepType="ai_step" sectionKey="advanced" title="Advanced" defaultOpen>
                    <div>secret setting</div>
                </AccordionSection>
            </FormDensityContext.Provider>
        );
        const { rerender } = render(ui('simple'));
        expect(screen.queryByText('secret setting')).toBeNull();
        rerender(ui('advanced'));
        expect(screen.queryByRole('button', { name: /Advanced/ })).toBeNull();
        expect(screen.getByText('secret setting')).toBeTruthy();
    });

    it('a forEach the builder just set does not pull Advanced into Simple', () => {
        // The builder just set a forEach after a connect: hasContent flips.
        const ui = (hasContent) => (
            <FormDensityContext.Provider value={{ density: 'quick', mode: 'simple' }}>
                <AccordionSection stepType="ai_step" sectionKey="advanced" title="Advanced" hasContent={hasContent}>
                    <div>secret setting</div>
                </AccordionSection>
            </FormDensityContext.Provider>
        );
        const { rerender } = render(ui(false));
        rerender(ui(true));
        expect(screen.queryByText('secret setting')).toBeNull();
    });

    it('Advanced → Simple hides again without opening anything else', () => {
        const onHiddenSection = vi.fn();
        const ui = (mode) => (
            <FormDensityContext.Provider value={{ density: 'quick', mode, onHiddenSection }}>
                <AccordionSection stepType="ai_step" sectionKey="advanced" title="Advanced">
                    <div>secret setting</div>
                </AccordionSection>
            </FormDensityContext.Provider>
        );
        const { rerender } = render(ui('advanced'));
        expect(screen.getByText('secret setting')).toBeTruthy();
        rerender(ui('simple'));
        expect(screen.queryByText('secret setting')).toBeNull();
        expect(onHiddenSection).toHaveBeenCalledWith('advanced');
    });

    it('reports becoming visible so the host can drain its hidden count', () => {
        const onShownSection = vi.fn();
        const ui = (mode) => (
            <FormDensityContext.Provider value={{ density: 'quick', mode, onShownSection }}>
                <AccordionSection stepType="ai_step" sectionKey="advanced" title="Advanced">
                    <div>secret setting</div>
                </AccordionSection>
            </FormDensityContext.Provider>
        );
        const { rerender } = render(ui('simple'));
        expect(onShownSection).not.toHaveBeenCalled();
        rerender(ui('advanced'));
        expect(onShownSection).toHaveBeenCalledWith('advanced');
    });
});
