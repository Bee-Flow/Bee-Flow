import { render, fireEvent, within } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { clampKnob } from './styleKnobMeta';
import StyleSection, { updateSectionStyle, findSectionById } from './StyleSection';
import { findNode, updateNodeStyle } from '../state/definitionOps';
import { KITCHEN_SINK } from '../state/sampleDefinitions';

const nodeOf = (id) => findNode(KITCHEN_SINK, id).node;

function renderNode(nodeId, onCommit = vi.fn()) {
    const utils = render(
        <StyleSection definition={KITCHEN_SINK} node={nodeOf(nodeId)} onCommit={onCommit} />,
    );
    return { onCommit, ...utils };
}

describe('StyleSection — span slider', () => {
    it('commits an int span patch through updateNodeStyle', () => {
        const { onCommit, container } = renderNode('cmp_headg1');
        const slider = container.querySelector('input[type="range"]');
        fireEvent.change(slider, { target: { value: '7' } });
        expect(onCommit).toHaveBeenCalledTimes(1);
        const next = onCommit.mock.calls[0][0];
        expect(next).not.toBe(KITCHEN_SINK);
        expect(findNode(next, 'cmp_headg1').node.style.span).toBe(7);
        // Untouched props/screens keep identity (pure ops, structural sharing).
        expect(findNode(next, 'cmp_headg1').node.props).toBe(nodeOf('cmp_headg1').props);
    });

    it('clamps out-of-range values to the server STYLE_KNOBS bounds', () => {
        expect(clampKnob('span', 99)).toBe(12);
        expect(clampKnob('span', -3)).toBe(1);
        expect(clampKnob('span', 6.6)).toBe(7);
        expect(clampKnob('padding', 42)).toBe(6);

        // cmp_stat01 spans 3 cols — an over-range change lands on the max (12),
        // whether jsdom's own range sanitisation or clampKnob catches it first.
        const { onCommit, container } = renderNode('cmp_stat01');
        const slider = container.querySelector('input[type="range"]');
        fireEvent.change(slider, { target: { value: '15' } });
        expect(onCommit).toHaveBeenCalledTimes(1);
        const next = onCommit.mock.calls[0][0];
        expect(findNode(next, 'cmp_stat01').node.style.span).toBe(12);
    });
});

describe('StyleSection — TokenColorField', () => {
    it('commits a role name when a role swatch is picked', () => {
        const { onCommit, getByRole } = renderNode('cmp_headg1');
        // Fixture color is null → "Theme" mode; switching tab alone commits nothing.
        fireEvent.click(getByRole('radio', { name: 'Role' }));
        expect(onCommit).not.toHaveBeenCalled();
        fireEvent.click(getByRole('radio', { name: 'success' }));
        expect(onCommit).toHaveBeenCalledTimes(1);
        expect(findNode(onCommit.mock.calls[0][0], 'cmp_headg1').node.style.color).toBe('success');
    });

    it('commits null when switching a role-colored node back to Theme', () => {
        // cmp_stat01 has style.color 'primary' → starts in Role mode.
        const { onCommit, getByRole } = renderNode('cmp_stat01');
        expect(getByRole('radio', { name: 'primary' })).toHaveAttribute('aria-checked', 'true');
        fireEvent.click(getByRole('radio', { name: 'Theme' }));
        expect(onCommit).toHaveBeenCalledTimes(1);
        expect(findNode(onCommit.mock.calls[0][0], 'cmp_stat01').node.style.color).toBeNull();
    });

    it('commits a hex when a custom preset is picked', () => {
        const { onCommit, getByRole } = renderNode('cmp_headg1');
        fireEvent.click(getByRole('radio', { name: 'Custom' }));
        expect(onCommit).not.toHaveBeenCalled();
        fireEvent.click(getByRole('radio', { name: '#B45309' }));
        expect(findNode(onCommit.mock.calls[0][0], 'cmp_headg1').node.style.color).toBe('#B45309');
    });
});

describe('StyleSection — per-type knob gating', () => {
    it('divider renders only the span slider', () => {
        const { container, queryByRole, queryByText } = renderNode('cmp_divid1');
        expect(container.querySelectorAll('input[type="range"]')).toHaveLength(1);
        expect(queryByRole('radio')).toBeNull();
        expect(queryByText('Align')).toBeNull();
        expect(queryByText('Color')).toBeNull();
    });

    it('card renders span/padding/gap sliders + radius/background enums, no color', () => {
        const { container, getByRole, queryByRole } = renderNode('cmp_card01');
        expect(container.querySelectorAll('input[type="range"]')).toHaveLength(3);
        expect(getByRole('radio', { name: 'Inherit' })).toBeInTheDocument(); // radius null option
        // Background is the house select since the look pass (five values no
        // longer fit a segmented row) — mirror STYLE_KNOBS, first value first.
        const background = getByRole('combobox', { name: 'Background' });
        expect(Array.from(background.options).map((o) => o.value))
            .toEqual(['none', 'surface', 'tint', 'panel', 'gradient']);
        expect(background).toHaveValue('surface'); // the fixture card's stored value
        expect(queryByRole('radio', { name: 'Theme' })).toBeNull(); // no color knob
    });

    it('background commits the look-pass values (panel)', () => {
        const { onCommit, getByRole } = renderNode('cmp_card01');
        fireEvent.change(getByRole('combobox', { name: 'Background' }), { target: { value: 'panel' } });
        expect(onCommit).toHaveBeenCalledTimes(1);
        expect(findNode(onCommit.mock.calls[0][0], 'cmp_card01').node.style.background).toBe('panel');
    });

    it('radius "Inherit" commits null', () => {
        const onCommit = vi.fn();
        const { getByRole } = render(
            <StyleSection definition={KITCHEN_SINK} node={nodeOf('cmp_card01')} onCommit={onCommit} />,
        );
        // Fixture card radius is 'md' → switching to Inherit commits null.
        fireEvent.click(getByRole('radio', { name: 'Inherit' }));
        expect(onCommit).toHaveBeenCalledTimes(1);
        expect(findNode(onCommit.mock.calls[0][0], 'cmp_card01').node.style.radius).toBeNull();
    });
});

describe('StyleSection — section variant', () => {
    it('renders the section trio and commits via the local section patch', () => {
        const onCommit = vi.fn();
        const { container, getByRole } = render(
            <StyleSection definition={KITCHEN_SINK} sectionId="sec_dash01" onCommit={onCommit} />,
        );
        // padding + gap sliders, background enum — and NO span slider.
        expect(container.querySelectorAll('input[type="range"]')).toHaveLength(2);
        const background = getByRole('combobox', { name: 'Background' });
        expect(Array.from(background.options).map((o) => o.value))
            .toEqual(['none', 'surface', 'tint', 'panel', 'gradient']);

        const padding = container.querySelectorAll('input[type="range"]')[0];
        fireEvent.change(padding, { target: { value: '6' } });
        expect(onCommit).toHaveBeenCalledTimes(1);
        const next = onCommit.mock.calls[0][0];
        expect(findSectionById(next, 'sec_dash01').section.style.padding).toBe(6);
        expect(next).not.toBe(KITCHEN_SINK);
    });

    it('updateSectionStyle is a no-op (same reference) for identical patches', () => {
        expect(updateSectionStyle(KITCHEN_SINK, 'sec_dash01', { padding: 4 })).toBe(KITCHEN_SINK);
        expect(updateSectionStyle(KITCHEN_SINK, 'sec_nope', { padding: 1 })).toBe(KITCHEN_SINK);
    });
});

describe('StyleSection — responsive visibility disclosure', () => {
    it('appears for span-bearing types, commits a band, and hides for sections', () => {
        const utils = renderNode('cmp_headg1');
        const scope = within(utils.container);
        fireEvent.click(scope.getByRole('button', { name: /Responsive/i }));
        const below = within(scope.getByRole('radiogroup', { name: 'Hide below' }));
        fireEvent.click(below.getByRole('radio', { name: 'M' }));
        expect(utils.onCommit).toHaveBeenCalledTimes(1);
        expect(findNode(utils.onCommit.mock.calls[0][0], 'cmp_headg1').node.style.hideBelow).toBe('md');

        // Sections have no span → no responsive disclosure at all.
        const section = render(
            <StyleSection definition={KITCHEN_SINK} sectionId={KITCHEN_SINK.screens[0].sections[0].id} onCommit={vi.fn()} />,
        );
        expect(within(section.container).queryByRole('button', { name: /Responsive/i })).toBeNull();
    });
});

// ── Advanced sizing ─────────────────────────────────────────────────────────
//
// The column slider stays the PRIMARY control — exact px/% lives behind a
// disclosure so it does not sit in front of every author. cmp_card01 has both
// span and height (so both pairs appear); cmp_headg1 has span only.

/**
 * Open the disclosure and hand back queries scoped to THIS render's container.
 * Both pairs use a `px` option, so an unscoped query is ambiguous by design —
 * the unit picker's aria-label ("Width unit" / "Height unit") is what
 * disambiguates them, for a screen reader as much as for this test.
 */
function openAdvanced(utils) {
    const scope = within(utils.container);
    fireEvent.click(scope.getByRole('button', { name: /Advanced sizing/i }));
    return {
        ...utils,
        scope,
        width: () => within(scope.getByRole('radiogroup', { name: 'Width unit' })),
        height: () => within(scope.getByRole('radiogroup', { name: 'Height unit' })),
    };
}

describe('StyleSection — advanced sizing disclosure', () => {
    it('is collapsed by default: the column slider is what an author sees first', () => {
        const { container } = renderNode('cmp_card01');
        const scope = within(container);
        // The primary control is present and unchanged...
        expect(container.querySelectorAll('input[type="range"]').length).toBeGreaterThan(0);
        // ...and nothing about px/% is on screen until asked for.
        expect(scope.getByRole('button', { name: /Advanced sizing/i })).toBeInTheDocument();
        expect(scope.queryByRole('radiogroup', { name: 'Width unit' })).toBeNull();
        expect(scope.queryByRole('radio', { name: 'px' })).toBeNull();
    });

    it('offers the pairs a type has EARNED — width needs span, height needs height', () => {
        // card: span + height → both pairs.
        const card = openAdvanced(renderNode('cmp_card01'));
        expect(card.width().getByRole('radio', { name: 'Columns' })).toBeInTheDocument();
        expect(card.width().getByRole('radio', { name: '%' })).toBeInTheDocument();
        expect(card.height().getByRole('radio', { name: 'Preset' })).toBeInTheDocument();
        expect(card.height().getByRole('radio', { name: 'vh' })).toBeInTheDocument();

        // heading: span, no height → width pair only.
        const heading = openAdvanced(renderNode('cmp_headg1'));
        expect(heading.width().getByRole('radio', { name: 'Columns' })).toBeInTheDocument();
        expect(heading.scope.queryByRole('radiogroup', { name: 'Height unit' })).toBeNull();
    });

    it('picking a unit commits the mode AND seeds a usable number in one patch', () => {
        // Half a pair renders as if the knob were never touched (and the server
        // errors on it), so the two are always committed together.
        const utils = openAdvanced(renderNode('cmp_card01'));
        fireEvent.click(utils.width().getByRole('radio', { name: 'px' }));
        expect(utils.onCommit).toHaveBeenCalledTimes(1);
        const style = findNode(utils.onCommit.mock.calls[0][0], 'cmp_card01').node.style;
        expect(style.widthMode).toBe('px');
        expect(style.widthValue).toBe(320); // the px unit default
    });

    it('typing a width commits it clamped to the unit currently selected', () => {
        const definition = updateNodeStyle(KITCHEN_SINK, 'cmp_card01', { widthMode: 'px', widthValue: 320 });
        const onCommit = vi.fn();
        const utils = openAdvanced(render(
            <StyleSection definition={definition} node={findNode(definition, 'cmp_card01').node} onCommit={onCommit} />,
        ));
        const field = utils.scope.getByRole('spinbutton');
        fireEvent.change(field, { target: { value: '5000' } });
        expect(findNode(onCommit.mock.calls[0][0], 'cmp_card01').node.style.widthValue).toBe(2000);

        // The same number under % is nonsense — the range follows the unit.
        expect(clampKnob('widthValue', 5000, { widthMode: 'px' })).toBe(2000);
        expect(clampKnob('widthValue', 5000, { widthMode: 'pct' })).toBe(100);
        expect(clampKnob('widthValue', 3, { widthMode: 'px' })).toBe(40);
        expect(clampKnob('widthValue', 50, { widthMode: 'span' })).toBeNull();
        expect(clampKnob('widthValue', null, { widthMode: 'px' })).toBeNull();
    });

    it('switching back to Columns clears the number, so nothing dead is stored', () => {
        const definition = updateNodeStyle(KITCHEN_SINK, 'cmp_card01', { widthMode: 'px', widthValue: 640 });
        const onCommit = vi.fn();
        const utils = openAdvanced(render(
            <StyleSection definition={definition} node={findNode(definition, 'cmp_card01').node} onCommit={onCommit} />,
        ));
        fireEvent.click(utils.width().getByRole('radio', { name: 'Columns' }));
        const style = findNode(onCommit.mock.calls[0][0], 'cmp_card01').node.style;
        expect(style.widthMode).toBe('span');
        expect(style.widthValue).toBeNull(); // canonicalize drops it entirely
    });

    it('a section is never offered %, because a section has no parent height', () => {
        const onCommit = vi.fn();
        const utils = openAdvanced(render(
            <StyleSection definition={KITCHEN_SINK} sectionId="sec_dash01" onCommit={onCommit} />,
        ));
        // Height pair only (a section has no span), and without the unit the
        // server rejects there.
        expect(utils.height().getByRole('radio', { name: 'Preset' })).toBeInTheDocument();
        expect(utils.height().getByRole('radio', { name: 'vh' })).toBeInTheDocument();
        expect(utils.height().queryByRole('radio', { name: '%' })).toBeNull();
        expect(utils.scope.queryByRole('radiogroup', { name: 'Width unit' })).toBeNull();

        fireEvent.click(utils.height().getByRole('radio', { name: 'vh' }));
        const style = findSectionById(onCommit.mock.calls[0][0], 'sec_dash01').section.style;
        expect(style.heightMode).toBe('vh');
        expect(style.heightValue).toBe(50);
    });
});
