import { render } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import AtomRenderer from './AtomRenderer';

describe('AtomRenderer', () => {
    it('renders nothing for a node type without a node view', () => {
        const { container } = render(<AtomRenderer node={{ type: 'paragraph' }} view={null} selected={false} editable brokenLabel="broken" />);
        expect(container.innerHTML).toBe('');
    });
});
