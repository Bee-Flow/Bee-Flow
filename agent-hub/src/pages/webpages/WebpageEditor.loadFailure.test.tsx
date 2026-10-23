import { render, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';

// Monaco's chunk cannot be loaded: the editor must fall back to the textarea
// instead of throwing on a null lazy component.
vi.mock('@monaco-editor/react', () => { throw new Error('Failed to fetch dynamically imported module'); });

const { default: WebpageEditor } = await import('./WebpageEditor');

describe('WebpageEditor when Monaco fails to load', () => {
    it('shows the plain textarea instead of crashing', async () => {
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        render(<WebpageEditor value="<p>x</p>" language="html" />);
        const box = await waitFor(() => screen.getByRole('textbox'));
        expect(box).toHaveValue('<p>x</p>');
        errorSpy.mockRestore();
    });
});
