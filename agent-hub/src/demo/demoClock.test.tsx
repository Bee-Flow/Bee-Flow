import { render } from '@testing-library/react';
import { Component, StrictMode, type ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEMO_NOW_ISO, demoDate, demoNow, installDemoClock, uninstallDemoClock } from './demoClock';
import DemoHost from './DemoHost';
import useDemoClock from './useDemoClock';

const DEMO_DAY = DEMO_NOW_ISO.slice(0, 10);
const MINUTE = 60_000;
const RealDate = Date;
const today = () => new Date().toISOString().slice(0, 10);
const wait = (ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); });

afterEach(() => {
    vi.useRealTimers();
    // Whatever a failed test left behind: every holder lets go.
    for (let i = 0; i < 5; i += 1) uninstallDemoClock();
    expect(Date).toBe(RealDate);
});

describe('the demo clock', () => {
    it('starts at the demo date, whatever the real date is', () => {
        const demo = Date.parse(DEMO_NOW_ISO);
        expect(demoNow()).toBeGreaterThanOrEqual(demo);
        expect(demoNow() - demo).toBeLessThan(10 * MINUTE);
        expect(demoDate().toISOString().slice(0, 10)).toBe(DEMO_DAY);
    });

    it('runs: it is shifted, not frozen', async () => {
        installDemoClock();
        const first = Date.now();
        const firstDate = new Date().getTime();
        const mark = performance.now();
        await wait(30);
        const elapsed = performance.now() - mark;
        // Elapsed time measured with Date is the real elapsed time (staleness, debounce, durations).
        expect(Date.now() - first).toBeGreaterThanOrEqual(20);
        expect(Math.abs((Date.now() - first) - elapsed)).toBeLessThan(15);
        expect(new Date().getTime() - firstDate).toBeGreaterThanOrEqual(20);
        expect(today()).toBe(DEMO_DAY);
    });

    it('answers the demo time for the three ways of asking for now', () => {
        installDemoClock();
        expect(today()).toBe(DEMO_DAY);
        expect(Math.abs(Date.now() - demoNow())).toBeLessThan(MINUTE);
        // Date() called as a function answers a string, as the real one does.
        const asText = (Date as unknown as () => string)();
        expect(typeof asText).toBe('string');
        expect(new RealDate(asText).toISOString().slice(0, 10)).toBe(DEMO_DAY);
    });

    it('is the real Date in every other respect', () => {
        const made = new Date(2020, 0, 1);
        installDemoClock();
        expect(new Date(1_700_000_000_000).getTime()).toBe(1_700_000_000_000);
        expect(new Date('2026-12-02T00:00:00Z').getTime()).toBe(RealDate.parse('2026-12-02T00:00:00Z'));
        expect(new Date(2020, 0, 1).getTime()).toBe(made.getTime());
        expect(new Date(2020, 0, 1, 12, 30, 15, 250).getTime()).toBe(new RealDate(2020, 0, 1, 12, 30, 15, 250).getTime());
        expect(new Date(made).getTime()).toBe(made.getTime());
        expect(Number.isNaN(new Date('nonsense').getTime())).toBe(true);
        expect(Date.parse('2026-01-01T00:00:00Z')).toBe(RealDate.parse('2026-01-01T00:00:00Z'));
        expect(Date.UTC(2026, 0, 1)).toBe(RealDate.UTC(2026, 0, 1));
        expect(Date.prototype).toBe(RealDate.prototype);
        expect(Date.name).toBe('Date');
        expect(Date.length).toBe(RealDate.length);
        // Dates made before, during and after are all dates, to both constructors.
        const during = new Date();
        expect(made instanceof Date).toBe(true);
        expect(during instanceof Date).toBe(true);
        expect(during instanceof RealDate).toBe(true);
        expect(Object.getPrototypeOf(during)).toBe(RealDate.prototype);
        expect(Object.prototype.toString.call(during)).toBe('[object Date]');
        class Stamp extends Date { day() { return this.toISOString().slice(0, 10); } }
        expect(new Stamp().day()).toBe(DEMO_DAY);
        expect(new Stamp() instanceof Stamp).toBe(true);

        uninstallDemoClock();
        expect(Date).toBe(RealDate);
        expect(during instanceof Date).toBe(true);
        expect(new Date() instanceof Date).toBe(true);
        expect(Math.abs(Date.now() - RealDate.now())).toBeLessThan(MINUTE);
    });

    it('leaves performance.now() alone', () => {
        const now = performance.now;
        const before = performance.now();
        installDemoClock();
        expect(performance.now).toBe(now);
        expect(performance.now() - before).toBeLessThan(1000);
    });

    it('is counted: the page gets its own clock back with the last holder', () => {
        installDemoClock();
        installDemoClock();
        uninstallDemoClock();
        expect(today()).toBe(DEMO_DAY);
        uninstallDemoClock();
        expect(Date).toBe(RealDate);
        // One call too many is harmless.
        uninstallDemoClock();
        installDemoClock();
        expect(today()).toBe(DEMO_DAY);
    });

    it('leaves a clock that was put over it alone, and is taken back once that one is gone', () => {
        installDemoClock();
        vi.useFakeTimers({ toFake: ['Date'] });
        const fake = Date;
        uninstallDemoClock();
        expect(Date).toBe(fake);
        vi.useRealTimers();
        uninstallDemoClock();
        expect(Date).toBe(RealDate);
    });
});

describe('useDemoClock — only while a host is mounted', () => {
    function Host({ active = true, children }: { active?: boolean; children?: ReactNode }) {
        useDemoClock(active);
        return <>{children}</>;
    }

    it('installs on mount and restores on unmount', () => {
        const { unmount } = render(<Host />);
        expect(today()).toBe(DEMO_DAY);
        unmount();
        expect(Date).toBe(RealDate);
    });

    it('does nothing for a host that does not want it', () => {
        const { unmount } = render(<Host active={false} />);
        expect(Date).toBe(RealDate);
        unmount();
        expect(Date).toBe(RealDate);
    });

    it('comes out as one install under StrictMode\'s double mount', () => {
        const { unmount } = render(<StrictMode><Host /></StrictMode>);
        expect(today()).toBe(DEMO_DAY);
        unmount();
        expect(Date).toBe(RealDate);
    });

    it('keeps the clock for a second host until both are gone', () => {
        const a = render(<Host />);
        const b = render(<Host />);
        a.unmount();
        expect(today()).toBe(DEMO_DAY);
        b.unmount();
        expect(Date).toBe(RealDate);
    });

    class Boundary extends Component<{ children: ReactNode }, { failed: boolean }> {
        state = { failed: false };
        static getDerivedStateFromError() { return { failed: true }; }
        render() { return this.state.failed ? <p>failed</p> : this.props.children; }
    }
    function Throws(): ReactNode { throw new Error('child failed'); }

    it('restores when a child throws on the first render and the host never mounts', () => {
        const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
        const { getByText, unmount } = render(<Boundary><Host><Throws /></Host></Boundary>);
        expect(getByText('failed')).toBeTruthy();
        expect(Date).toBe(RealDate);
        unmount();
        quiet.mockRestore();
    });

    it('restores when a child throws later and the boundary takes the host down', () => {
        const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
        function Later({ fail }: { fail: boolean }): ReactNode { if (fail) throw new Error('later'); return <p>fine</p>; }
        const { rerender, getByText } = render(<Boundary><Host><Later fail={false} /></Host></Boundary>);
        expect(today()).toBe(DEMO_DAY);
        rerender(<Boundary><Host><Later fail /></Host></Boundary>);
        expect(getByText('failed')).toBeTruthy();
        expect(Date).toBe(RealDate);
        quiet.mockRestore();
    });
});

describe('DemoHost and the clock', () => {
    it('shows a demo on the demo date, and only while it is mounted', () => {
        const { unmount } = render(<StrictMode><DemoHost feature="compliance" /></StrictMode>);
        expect(today()).toBe(DEMO_DAY);
        unmount();
        expect(Date).toBe(RealDate);
    });

    it('does not touch the clock for a demo that does not exist', () => {
        const { unmount } = render(<DemoHost feature="no-such-demo" />);
        expect(Date).toBe(RealDate);
        unmount();
    });
});
