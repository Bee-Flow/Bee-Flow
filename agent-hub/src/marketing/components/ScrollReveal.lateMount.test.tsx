import { useRef } from 'react';
import { render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useScrollReveal } from './ScrollReveal';

type Callback = (entries: Array<{ isIntersecting: boolean; target: Element }>) => void;

function Page() {
    const ref = useRef<HTMLDivElement>(null);
    useScrollReveal(ref, 'stable');
    return <div ref={ref} data-testid="root"><div className="reveal" id="early" /></div>;
}

describe('useScrollReveal with sections that mount after the first effect', () => {
    const observed: Element[] = [];
    let callback: Callback = () => undefined;

    beforeEach(() => {
        observed.length = 0;
        vi.stubGlobal('matchMedia', () => ({ matches: false }));
        vi.stubGlobal('IntersectionObserver', class {
            constructor(cb: Callback) { callback = cb; }
            observe(el: Element) { observed.push(el); }
            unobserve() { return undefined; }
            disconnect() { return undefined; }
        });
    });
    afterEach(() => { vi.unstubAllGlobals(); });

    it('observes and reveals a .reveal node added later, as a lazy chunk does', async () => {
        const { getByTestId } = render(<Page />);
        const late = document.createElement('div');
        late.className = 'reveal';
        getByTestId('root').appendChild(late);
        await waitFor(() => expect(observed).toContain(late));
        callback([{ isIntersecting: true, target: late }]);
        expect(late.classList.contains('visible')).toBe(true);
    });
});
