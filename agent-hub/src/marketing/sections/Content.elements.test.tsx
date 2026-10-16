import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import Content from './Content';
import type { ContentBlockData } from './Content.types';

function dataWith(kind: string): ContentBlockData {
    return {
        enabled: true,
        columnLayout: '1',
        columns: [{
            id: 'c1',
            elements: [{ id: 'e1', kind, label: 'Try it', link: { kind: 'external', href: '/demo' } }],
        }],
    } as unknown as ContentBlockData;
}

describe('Content element kinds', () => {
    it.each(['cta', 'button', 'link'])('renders a %s element as a button link', (kind) => {
        const { container } = render(<Content data={dataWith(kind)} />);
        const a = container.querySelector('a');
        expect(a?.textContent).toContain('Try it');
        expect(a?.getAttribute('href')).toBe('/demo');
    });

    it('still drops a kind it does not know', () => {
        const { container } = render(<Content data={dataWith('banner')} />);
        expect(container.querySelector('a')).toBeNull();
    });
});
