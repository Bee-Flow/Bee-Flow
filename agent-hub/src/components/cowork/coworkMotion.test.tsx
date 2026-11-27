// The motion of Cowork (./coworkMotion.ts): what the class names are, that the stylesheet switches every one of them
// off under reduced motion and leaves no transform at rest, and how <Expand> and useLeave follow an element's own
// animations: at once where the DOM reports none (this test DOM, reduced motion), after they end where it does.
import { act, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { readStylesheet } from '@/test/appStylesheets';
import { ENTER, EXPAND, Expand, LEAVE, SPIN, STAGGER, SWAP, TINT, useLeave } from './coworkMotion';

// Read once: the rules between the "Cowork motion" heading of app.css and the next section.
const css = readStylesheet('app.css');
const motion = css.slice(css.indexOf('Cowork motion (components/cowork/coworkMotion.ts)'), css.indexOf('Sidebar slide-in animation'));
const withoutKeyframes = motion.replace(/@keyframes\s+\w+\s*\{(?:[^{}]|\{[^{}]*\})*\}/g, '');
const reducedMotion = [...motion.matchAll(/@media \(prefers-reduced-motion: reduce\)\s*\{((?:[^{}]|\{[^{}]*\})*)\}/g)].map((m) => m[1]).join('\n');

/** The declarations of the rule whose selector is exactly `selector`. */
function rule(selector: string): string {
    const at = withoutKeyframes.indexOf(`\n${selector} {`);
    return at === -1 ? '' : withoutKeyframes.slice(at, withoutKeyframes.indexOf('}', at));
}

describe('the Cowork motion in the stylesheet', () => {
    it('has a rule for every class the constants name', () => {
        expect(motion.length).toBeGreaterThan(0);
        for (const name of [ENTER, SWAP, LEAVE, SPIN, EXPAND]) expect(withoutKeyframes).toContain(`.${name}`);
        for (const i of [1, 2, 3, 4, 5]) expect(withoutKeyframes).toContain(`.${STAGGER(i).split(' ')[1]} {`);
    });

    it('is switched off under prefers-reduced-motion: reduce, every class of it', () => {
        expect(reducedMotion).toMatch(/animation:\s*none/);
        for (const name of [ENTER, SWAP, LEAVE, SPIN, EXPAND]) expect(reducedMotion).toContain(`.${name}`);
    });

    it('leaves nothing on an element at rest: the arrival fills backwards only, and no rule sets a transform or a filter', () => {
        expect(rule(`.${ENTER}`)).toMatch(/animation:\s*coworkEnter\s+160ms\s+ease-out\s+backwards\s*;/);
        expect(rule(`.${SWAP}`)).toMatch(/backwards\s*;/);
        expect(withoutKeyframes).not.toMatch(/\b(transform|filter|backdrop-filter|will-change)\s*:/);
        expect(withoutKeyframes.match(/infinite/g)).toHaveLength(1);
        expect(rule(`.${SPIN}`)).toContain('infinite');
        const durations = [...withoutKeyframes.replace(rule(`.${SPIN}`), '').matchAll(/animation:[^;]*?(\d+)ms/g)].map((m) => Number(m[1]));
        expect(durations.length).toBeGreaterThan(0);
        expect(Math.max(...durations)).toBeLessThanOrEqual(200);
    });
});

describe('the motion constants', () => {
    it('are plain class names; the persistent ones are no transform', () => {
        expect(ENTER).toBe('cowork-enter');
        for (const name of [ENTER, SWAP, LEAVE, SPIN, EXPAND, TINT]) expect(name).not.toMatch(/translate|scale|rotate|skew|blur|filter|will-change/);
        expect(TINT).toContain('duration-[120ms]');
        expect(TINT).toContain('motion-reduce:transition-none');
    });

    it('STAGGER is ENTER for the first six rows, 30ms apart, and nothing for the rows after them', () => {
        expect(STAGGER(0)).toBe(ENTER);
        expect(STAGGER(1)).toBe(`${ENTER} cowork-stagger-1`);
        expect(STAGGER(5)).toBe(`${ENTER} cowork-stagger-5`);
        expect(STAGGER(6)).toBe('');
        expect(rule('.cowork-stagger-1')).toContain('animation-delay: 30ms');
        expect(rule('.cowork-stagger-5')).toContain('animation-delay: 150ms');
    });
});

function Toast({ open }: { open: boolean }) {
    const { ref, mounted, leaving } = useLeave<HTMLParagraphElement>(open);
    return mounted ? <p ref={ref} className={leaving ? LEAVE : ENTER}>Saved</p> : null;
}

/** Makes the DOM report one running animation per element, which ends when the returned function is called. */
function animationsThatEndOnDemand(): () => Promise<void> {
    let end: () => void = () => {};
    const finished = new Promise<void>((resolve) => { end = resolve; });
    Object.defineProperty(Element.prototype, 'getAnimations', { configurable: true, value: () => [{ finished }] });
    return async () => { await act(async () => { end(); await finished; }); };
}

afterEach(() => { Reflect.deleteProperty(Element.prototype, 'getAnimations'); });

describe('<Expand>', () => {
    it('renders nothing while closed, its body with the id while open, and is gone at once where nothing animates', () => {
        const { rerender, container } = render(<Expand open={false} id="body" className="p-4">Inside</Expand>);
        expect(container).toBeEmptyDOMElement();
        rerender(<Expand open id="body" className="p-4">Inside</Expand>);
        const body = screen.getByText('Inside');
        expect(body).toHaveAttribute('id', 'body');
        expect(body).toHaveClass('p-4');
        expect(body.parentElement).toHaveClass(EXPAND);
        expect(body.parentElement).toHaveAttribute('data-open', 'settled');
        rerender(<Expand open={false} id="body" className="p-4">Inside</Expand>);
        expect(container).toBeEmptyDOMElement();
    });

    it('where the DOM reports animations: opens moving, settles when they end, and stays while it closes', async () => {
        let end = animationsThatEndOnDemand();
        const { rerender, container } = render(<Expand open={false}>Inside</Expand>);
        rerender(<Expand open>Inside</Expand>);
        const wrapper = screen.getByText('Inside').parentElement as HTMLElement;
        expect(wrapper).toHaveAttribute('data-open', 'true');
        await end();
        expect(wrapper).toHaveAttribute('data-open', 'settled');
        end = animationsThatEndOnDemand();
        rerender(<Expand open={false}>Inside</Expand>);
        expect(wrapper).toHaveAttribute('data-open', 'false');
        expect(wrapper).toHaveAttribute('inert');
        expect(screen.getByText('Inside')).toBeInTheDocument();
        await end();
        expect(container).toBeEmptyDOMElement();
    });

    it('open when it mounts, it starts settled: no animation for what was already there', () => {
        animationsThatEndOnDemand();
        render(<Expand open>Inside</Expand>);
        expect(screen.getByText('Inside').parentElement).toHaveAttribute('data-open', 'settled');
    });
});

describe('useLeave', () => {
    it('keeps a leaving element mounted, with LEAVE, until its animation ends', async () => {
        const end = animationsThatEndOnDemand();
        const { rerender } = render(<Toast open />);
        expect(screen.getByText('Saved')).toHaveClass(ENTER);
        rerender(<Toast open={false} />);
        expect(screen.getByText('Saved')).toHaveClass(LEAVE);
        await end();
        expect(screen.queryByText('Saved')).toBeNull();
    });

    it('where nothing animates, the element is gone with `open`', () => {
        const { rerender } = render(<Toast open />);
        rerender(<Toast open={false} />);
        expect(screen.queryByText('Saved')).toBeNull();
    });
});
