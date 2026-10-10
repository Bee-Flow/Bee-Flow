import { render, screen } from '@testing-library/react';
import React from 'react';
import { describe, expect, it } from 'vitest';
import { ViewerStack } from './workspaceUi';

const people = { a: { name: 'Ann Able' }, b: { name: 'Bob Baker' }, c: { name: 'Cleo Cox' }, d: { name: 'Dan Dale' }, e: { name: 'Eve East' } };
const label = (name: string) => `${name} is viewing this`;

describe('ViewerStack', () => {
    it('renders nothing for nobody', () => {
        const { container } = render(<ViewerStack ids={[]} people={people} label={label} />);
        expect(container).toBeEmptyDOMElement();
    });

    it('shows at most three faces and a +n for the rest, with a tooltip naming everyone', () => {
        render(<ViewerStack ids={['a', 'b', 'c', 'd', 'e']} people={people} label={label} />);
        expect(screen.getByTestId('viewer-stack-more')).toHaveTextContent('+2');
        expect(screen.getByTestId('viewer-stack').getAttribute('title')).toContain('Dan Dale is viewing this');
        expect(screen.getByTestId('viewer-stack').querySelectorAll('[title]').length).toBe(3);
    });

    it('shows no +n when everyone fits', () => {
        render(<ViewerStack ids={['a', 'b']} people={people} label={label} />);
        expect(screen.queryByTestId('viewer-stack-more')).toBeNull();
    });
});
