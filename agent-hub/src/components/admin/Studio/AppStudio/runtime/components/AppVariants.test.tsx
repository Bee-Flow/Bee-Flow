import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { withoutPartClasses } from '@/test/appPartClasses';
import AppCallout from './AppCallout';
import AppCard from './AppCard';
import type { ComponentProps } from 'react';

/**
 * Component variants (props.variant, since 3) on the card and the callout. A node without the
 * prop, or with the identity value, renders exactly what it did before the prop existed.
 */

type CardNode = ComponentProps<typeof AppCard>['node'];
type CalloutNode = ComponentProps<typeof AppCallout>['node'];

const card = (props: Record<string, unknown> = {}) => ({
    id: 'cmp_card', type: 'card', visible: true, props: { title: 'Totals', ...props }, style: { span: 6, padding: 3, gap: 3, background: 'surface' },
}) as unknown as CardNode;

const callout = (props: Record<string, unknown> = {}) => ({
    id: 'cmp_call', type: 'callout', visible: true, props: { text: 'Heads up.', tone: 'warning', ...props }, style: { span: 12 },
}) as unknown as CalloutNode;

const cardClass = (props: Record<string, unknown>) => {
    const { container } = render(<AppCard node={card(props)}><div>kid</div></AppCard>);
    return withoutPartClasses(container.querySelector('.app-card')!.className);
};

describe('card variants', () => {
    it('plain, absent and unknown stamp nothing', () => {
        const identity = cardClass({});
        expect(identity).toBe('app-card flex flex-col');
        for (const variant of ['plain', 'constructor', 'raised', '']) expect(cardClass({ variant })).toBe(identity);
    });

    it('outlined and elevated stamp their class for AppCardVariants.css', () => {
        expect(cardClass({ variant: 'outlined' })).toBe('app-card flex flex-col app-card--outlined');
        expect(cardClass({ variant: 'elevated' })).toBe('app-card flex flex-col app-card--elevated');
    });

    it('sits after the look class when both are set', () => {
        expect(cardClass({ look: 'tinted', variant: 'outlined' })).toBe('app-card flex flex-col app-card--tinted app-card--outlined');
    });
});

const box = (props: Record<string, unknown>) => {
    const { container } = render(<AppCallout node={callout(props)} />);
    return container.querySelector<HTMLElement>('[data-app-callout]')!;
};

describe('callout variants', () => {
    it('soft, absent and unknown are the tinted block with a tone edge', () => {
        const identity = box({}).getAttribute('style');
        expect(identity).toContain('border-left');
        for (const variant of ['soft', 'bold', '']) expect(box({ variant }).getAttribute('style')).toBe(identity);
    });

    it('outline is transparent with a tone border all round', () => {
        const el = box({ variant: 'outline' });
        expect(el.style.background).toBe('transparent');
        expect(el.style.border).not.toBe('');
        expect(el.style.borderLeft).toBe(el.style.border);
        expect(el.style.color).toBe('var(--text-primary)');
    });

    it('solid fills with the tone and writes white text, body and meta included', () => {
        const { container } = render(<AppCallout node={callout({ variant: 'solid', meta: 'today' })} />);
        const el = container.querySelector<HTMLElement>('[data-app-callout]')!;
        expect(el.style.background).toContain('color-mix');
        expect(el.style.color).toBe('rgb(255, 255, 255)');
        expect(container.querySelector('.bfa-callout__body')!.className).not.toContain('text-[var(--text-secondary)]');
        expect(container.querySelector('.bfa-callout__meta')!.className).not.toContain('text-[var(--text-muted)]');
    });

    it('keeps the tone in the data attribute for every variant', () => {
        for (const variant of ['soft', 'outline', 'solid']) expect(box({ variant, tone: 'danger' })).toHaveAttribute('data-app-callout', 'danger');
    });
});
