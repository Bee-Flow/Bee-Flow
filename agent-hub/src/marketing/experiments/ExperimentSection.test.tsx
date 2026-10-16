import React from 'react';
import { render } from '@testing-library/react';
import { describe, it, expect, beforeEach } from 'vitest';
import ExperimentSection from './ExperimentSection';
import { experimentAttrs, resetDraws } from './experiment';

const Comp = ({ data }: { data: Record<string, unknown> }) => (
    <section className="demo"><h2>{String(data.title)}</h2></section>
);

/** The shape of what sits directly under the block wrapper, as ProductWebsite renders it. */
function wrapped(content: Record<string, unknown>) {
    const attrs = experimentAttrs(content, { random: () => 0 });
    const { container } = render(
        <div className="cms-block-wrap" {...attrs}>
            <ExperimentSection Comp={Comp} block={{ enabled: true, content }} preview={false} />
        </div>,
    );
    return container.querySelector('.cms-block-wrap') as HTMLElement;
}

beforeEach(() => resetDraws());

describe('ExperimentSection', () => {
    it('leaves the element tree under .cms-block-wrap the same with and without an experiment', () => {
        const plain = wrapped({ title: 'Control' });
        const tested = wrapped({ title: 'Control', abKey: 'k', abAlt: { title: 'Alt' } });
        const shape = (el: Element): string => `${el.tagName}.${el.className}[${[...el.children].map(shape).join(',')}]`;
        expect(shape(tested).replace('Alt', 'Control')).toBe(shape(plain));
        expect([...tested.children].map(c => c.tagName)).toEqual(['SECTION']);
        expect(tested.querySelector('.cms-experiment')).toBeNull();
    });

    it('carries the experiment on the block wrapper itself', () => {
        const tested = wrapped({ title: 'Control', abKey: 'k', abAlt: { title: 'Alt' } });
        expect(tested.dataset.cmsExperiment).toBe('k');
        expect(tested.dataset.cmsVariant).toBe('b');
        expect(tested.querySelector('h2')?.textContent).toBe('Alt');
        expect(wrapped({ title: 'Control' }).dataset.cmsExperiment).toBeUndefined();
    });
});

describe('ExperimentSection under a saturated band', () => {
    const Probe = ({ data }: { data: Record<string, unknown> }) => <p data-testid="variant">{String(data.backgroundVariant)}</p>;

    it('ignores a dark section variant when the block band is dark', () => {
        const { getByTestId } = render(
            <ExperimentSection Comp={Probe} block={{ enabled: true, content: { backgroundVariant: 'dark' }, style: { band: 'dark' } }} preview={false} />,
        );
        expect(getByTestId('variant').textContent).toBe('default');
    });
});
