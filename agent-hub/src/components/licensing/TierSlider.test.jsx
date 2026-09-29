import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';

import TierSlider from './TierSlider';
import scopedStorage from '../../utils/scopedStorage';

/**
 * The composer's tier control. Two things it must get right that a menu never
 * had to: the ORDER of the depth ladder, and the fact that Flow / Swarm / Write
 * are not part of that ladder — sliding "Write" between "Think" and "Deep
 * Thinking" would assert a ranking that does not exist.
 *
 * `configuredTierKeys` drops any tier with no model configured, so these
 * fixtures set `modelId` on exactly the tiers each case is about.
 */

// `auto` needs no modelId and is always offered, so every fixture below has
// four stops: auto, fast, thinking, pro.
const DEPTH_TIERS = {
    fast: { modelId: 'claude-sonnet-5' },
    thinking: { modelId: 'claude-sonnet-5' },
    pro: { modelId: 'claude-sonnet-5' },
};

function setup(tiers = DEPTH_TIERS, value = 'thinking') {
    const onChange = vi.fn();
    render(<TierSlider tiers={tiers} value={value} onChange={onChange} />);
    return { onChange };
}

/** Same, but able to change the selected tier — the gauge reads from it. */
function renderSlider(value) {
    const onChange = vi.fn();
    const view = render(<TierSlider tiers={DEPTH_TIERS} value={value} onChange={onChange} />);
    return {
        onChange,
        rerender: (next) => view.rerender(<TierSlider tiers={DEPTH_TIERS} value={next} onChange={onChange} />),
    };
}

const openPanel = async (user) => user.click(screen.getByTestId('tier-slider-trigger'));

beforeEach(() => {
    scopedStorage.removeItem('reasoningEffort');
});

describe('TierSlider', () => {
    it('is a gauge only — the tier NAME belongs in the panel, not the composer', () => {
        setup();
        const trigger = screen.getByTestId('tier-slider-trigger');
        expect(trigger).toHaveTextContent('');
        expect(trigger.querySelector('svg')).toBeInTheDocument();
        // Hover and assistive tech still get the name.
        expect(trigger).toHaveAttribute('aria-label', 'Response depth: Think');
        expect(screen.queryByTestId('tier-slider-track')).not.toBeInTheDocument();
    });

    it('lays the depth tiers out shallowest-first, with auto leading', async () => {
        const user = userEvent.setup();
        setup();
        await openPanel(user);

        const stops = screen.getAllByTestId(/^tier-slider-stop-/);
        expect(stops.map(el => el.getAttribute('data-testid'))).toEqual([
            'tier-slider-stop-auto',
            'tier-slider-stop-fast',
            'tier-slider-stop-thinking',
            'tier-slider-stop-pro',
        ]);
    });

    it('reports its position to assistive tech', async () => {
        const user = userEvent.setup();
        setup();
        await openPanel(user);

        const track = screen.getByTestId('tier-slider-track');
        expect(track).toHaveAttribute('role', 'slider');
        expect(track).toHaveAttribute('aria-valuemin', '0');
        expect(track).toHaveAttribute('aria-valuemax', '3');
        expect(track).toHaveAttribute('aria-valuenow', '2'); // auto, fast, [thinking], pro
        expect(track).toHaveAttribute('aria-valuetext', 'Think');
    });

    it('REGRESSION: every dot and its label sit on the same centre line', async () => {
        // The first cut positioned the dots with flex `space-between` and the
        // labels with `flex: 1` cells. Those two agree only while every dot is
        // the same size — and the active dot grows from 10px to 28px, which
        // reflowed the row and pushed each label off its dot.
        const user = userEvent.setup();
        setup();
        await openPanel(user);

        const dots = screen.getAllByTestId(/^tier-slider-stop-/);
        const labels = [...screen.getByTestId('tier-slider-labels').children];
        expect(labels).toHaveLength(dots.length);
        expect(labels.map(el => el.textContent)).toEqual(['Auto', 'Fast', 'Think', 'Deep Thinking']);

        dots.forEach((dot, i) => {
            expect(dot.style.left).toBeTruthy();
            expect(labels[i].style.left).toBe(dot.style.left);
        });
    });

    it('the fill ramps light-to-dark along the bar AND deepens with travel', async () => {
        // Two things at once: a gradient so the ramp is visible in one view,
        // and a dark end that tracks position so the levels differ from each
        // other. A single flat colour showed neither.
        const user = userEvent.setup();
        // The ink share of each color-mix stop — not the gradient's own 0%/100%
        // positions, which sit next to them in the serialised value.
        const stopsOf = (el) => [...el.style.background.matchAll(/--text-primary\)\s*(\d+)%/g)]
            .map(m => Number(m[1]));
        const strengthAt = (el) => {
            const pcts = stopsOf(el);
            expect(pcts.length).toBeGreaterThanOrEqual(2); // it is a gradient, not a flat fill
            expect(pcts[1]).toBeGreaterThan(pcts[0]);      // …and it gets darker rightward
            return pcts[1];
        };

        const { unmount } = render(<TierSlider tiers={DEPTH_TIERS} value="fast" onChange={vi.fn()} />);
        await openPanel(user);
        const atFast = strengthAt(screen.getByTestId('tier-slider-fill'));
        unmount();

        render(<TierSlider tiers={DEPTH_TIERS} value="pro" onChange={vi.fn()} />);
        await openPanel(user);
        const atPro = strengthAt(screen.getByTestId('tier-slider-fill'));

        expect(atPro).toBeGreaterThan(atFast);
        expect(atPro).toBe(44);            // deepest tier gets the darkest ink
        expect(atFast).toBeGreaterThan(10); // …and the shallow end still clears the track
    });

    it('the fill is mixed from theme ink, never from the free-form accent', async () => {
        const user = userEvent.setup();
        // --accent-primary is admin-chosen in Appearance and defaults to a cool
        // grey, which painted a grey bar across the warm Paper/Sepia presets.
        // Mixing --text-primary into --bg-tertiary keeps the bar in whatever
        // colour family the selected preset uses.
        render(<TierSlider tiers={DEPTH_TIERS} value="pro" onChange={vi.fn()} />);
        await openPanel(user);
        const bg = screen.getByTestId('tier-slider-fill').style.background;
        expect(bg).toContain('--text-primary');
        expect(bg).toContain('--bg-tertiary');
        expect(bg).not.toContain('--accent-primary');
    });

    it('centres each dot on its stop so growing the active one moves nothing', async () => {
        const user = userEvent.setup();
        setup();
        await openPanel(user);

        for (const dot of screen.getAllByTestId(/^tier-slider-stop-/)) {
            expect(dot.style.transform).toContain('translate(-50%, -50%)');
        }
    });

    const angleOf = () => {
        const t = screen.getByTestId('tier-gauge-needle').style.transform;
        return Number(/rotate\((-?[\d.]+)deg\)/.exec(t)[1]);
    };

    it('the gauge needle tracks the slider position', () => {
        const { rerender } = renderSlider('fast');

        const atFast = angleOf();
        rerender('thinking');
        const atThink = angleOf();
        rerender('pro');

        // Deeper tier → further clockwise, and Fast/Deep are the two ends.
        expect(atThink).toBeGreaterThan(atFast);
        expect(angleOf()).toBeGreaterThan(atThink);
        expect(atFast).toBe(-135);      // floor of the sweep
        expect(angleOf()).toBe(135);    // ceiling
    });

    it("AUTO drops the needle for an 'A' — it is not a position on the dial", () => {
        // Auto sits at the left of the TRACK but is not a depth: the router may
        // well pick Deep Thinking. A needle pinned to the minimum says the
        // opposite (and made Auto and Fast look nearly identical); a needle
        // parked mid-sweep would invent a depth instead.
        const { rerender } = renderSlider('auto');
        expect(screen.getByTestId('tier-gauge')).toHaveAttribute('data-mode', 'auto');
        expect(screen.getByTestId('tier-gauge-auto')).toHaveTextContent('A');
        expect(screen.queryByTestId('tier-gauge-needle')).not.toBeInTheDocument();

        rerender('fast');
        expect(screen.getByTestId('tier-gauge')).toHaveAttribute('data-mode', 'fixed');
        expect(screen.queryByTestId('tier-gauge-auto')).not.toBeInTheDocument();
        expect(screen.getByTestId('tier-gauge-needle')).toBeInTheDocument();
    });

    it('a tier off the depth scale lights nothing', async () => {
        const user = userEvent.setup();
        setup({ ...DEPTH_TIERS, standard: { modelId: 'claude-sonnet-5' } }, 'standard');
        expect(screen.getByTestId('tier-gauge')).toHaveAttribute('data-mode', 'off');
        await user.click(screen.getByTestId('tier-slider-trigger')); // still opens
        expect(screen.getByRole('dialog')).toBeInTheDocument();
    });

    it('the needle sweeps rather than jumps', () => {
        // `d` is not transitionable, so an earlier version animated nothing
        // whatever duration it declared. Rotation and stroke-dashoffset are.
        renderSlider('thinking');
        const needle = screen.getByTestId('tier-gauge-needle');
        expect(needle.style.transition).toMatch(/^transform \d{3}ms/);
        expect(Number(/(\d+)ms/.exec(needle.style.transition)[1])).toBeGreaterThanOrEqual(300);
    });

    it('shows the tier name and description inside the panel', async () => {
        const user = userEvent.setup();
        setup(DEPTH_TIERS, 'pro');
        await openPanel(user);

        const panel = screen.getByRole('dialog');
        expect(within(panel).getAllByText('Deep Thinking').length).toBeGreaterThan(0);
        expect(within(panel).getByText('Advanced reasoning')).toBeInTheDocument();
    });

    it('selects a tier when its stop is clicked', async () => {
        const user = userEvent.setup();
        const { onChange } = setup();
        await openPanel(user);

        await user.click(screen.getByTestId('tier-slider-stop-pro'));
        expect(onChange).toHaveBeenCalledWith('pro');
    });

    it('moves along the ladder with the arrow keys, and jumps with Home/End', async () => {
        const user = userEvent.setup();
        const { onChange } = setup();
        await openPanel(user);

        const track = screen.getByTestId('tier-slider-track');
        track.focus();

        await user.keyboard('{ArrowRight}');
        expect(onChange).toHaveBeenLastCalledWith('pro');

        await user.keyboard('{ArrowLeft}');
        expect(onChange).toHaveBeenLastCalledWith('fast');

        // Controlled component: `value` stays 'thinking' across these presses,
        // so each one is measured from the same starting index.
        await user.keyboard('{Home}');
        expect(onChange).toHaveBeenLastCalledWith('auto');

        await user.keyboard('{End}');
        expect(onChange).toHaveBeenLastCalledWith('pro');
    });

    it('does not fire onChange when the position does not move', async () => {
        const user = userEvent.setup();
        const { onChange } = setup(DEPTH_TIERS, 'auto');
        await openPanel(user);

        screen.getByTestId('tier-slider-track').focus();
        await user.keyboard('{Home}'); // already at the first stop
        expect(onChange).not.toHaveBeenCalled();
    });

    it('keeps Flow and Swarm OFF the ladder and offers them as separate choices', async () => {
        const user = userEvent.setup();
        const { onChange } = setup({
            ...DEPTH_TIERS,
            standard: { modelId: 'claude-sonnet-5' },
            swarm: { modelId: 'claude-sonnet-5' },
        });
        await openPanel(user);

        const stopIds = screen.getAllByTestId(/^tier-slider-stop-/).map(el => el.getAttribute('data-testid'));
        expect(stopIds).not.toContain('tier-slider-stop-standard');
        expect(stopIds).not.toContain('tier-slider-stop-swarm');

        const flow = screen.getByTestId('tier-slider-other-standard');
        expect(flow).toHaveTextContent('Flow');
        expect(within(flow).getByText('beta')).toBeInTheDocument();

        await user.click(flow);
        expect(onChange).toHaveBeenCalledWith('standard');
    });

    it('shows no ladder position when a non-depth tier is selected', async () => {
        const user = userEvent.setup();
        setup({ ...DEPTH_TIERS, standard: { modelId: 'claude-sonnet-5' } }, 'standard');

        expect(screen.getByTestId('tier-slider-trigger'))
            .toHaveAttribute('aria-label', 'Response depth: Flow');
        await openPanel(user);

        expect(screen.getByTestId('tier-slider-track'))
            .toHaveAttribute('aria-valuetext', 'Not on the depth scale');
        expect(screen.getByTestId('tier-slider-other-standard')).toHaveAttribute('aria-pressed', 'true');
    });

    it('carries the memory switch in the panel, not in the composer row', async () => {
        const user = userEvent.setup();
        const onToggle = vi.fn();
        render(<TierSlider
            tiers={DEPTH_TIERS} value="thinking" onChange={vi.fn()}
            memory={{ enabled: true, onToggle }}
        />);

        // Collapsed, the composer shows only the gauge — no stray second icon.
        expect(screen.queryByTestId('tier-slider-memory-toggle')).not.toBeInTheDocument();

        await openPanel(user);
        const toggle = screen.getByTestId('tier-slider-memory-toggle');
        expect(toggle).toHaveAttribute('aria-pressed', 'true');
        await user.click(toggle);
        expect(onToggle).toHaveBeenCalled();
    });

    it('omits the memory switch where the host does not offer one', async () => {
        const user = userEvent.setup();
        setup();
        await openPanel(user);
        expect(screen.queryByTestId('tier-slider-memory-toggle')).not.toBeInTheDocument();
    });

    it('an install with only Auto configured still gets a usable control', async () => {
        // `auto` needs no model, so this is what a fresh install looks like
        // before an admin points any tier at a model.
        const user = userEvent.setup();
        setup({}, 'auto');
        await openPanel(user);

        const stops = screen.getAllByTestId(/^tier-slider-stop-/);
        expect(stops).toHaveLength(1);
        expect(stops[0].style.left).toBe('50%'); // centred, not pinned to the edge
        expect(screen.getByTestId('tier-slider-track')).toHaveAttribute('aria-valuemax', '0');
    });

    it('MIGRATION: clears the effort override left behind by the old dropdown', () => {
        // useChatEngine still reads this key at send time and lets it win over
        // the tier's own effort. Left in place it would pin Deep Thinking to
        // whatever the removed dropdown was last set to.
        scopedStorage.setItem('reasoningEffort', 'low');
        setup();
        expect(scopedStorage.getItem('reasoningEffort')).toBeNull();
    });
});
