import { render, screen, waitFor } from '@testing-library/react';
import mermaid from 'mermaid';
import { afterEach, describe, expect, test, vi } from 'vitest';
import MermaidBlock from './MermaidBlock';

afterEach(() => { vi.restoreAllMocks(); });

describe('MermaidBlock', () => {
    test('a diagram fixed after a render error renders again', async () => {
        const renderSpy = vi.spyOn(mermaid, 'render')
            .mockRejectedValueOnce(new Error('Parse error on line 1'))
            .mockResolvedValueOnce({ svg: '<svg data-testid="diagram"></svg>', diagramType: 'flowchart' } as Awaited<ReturnType<typeof mermaid.render>>);
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const { rerender } = render(<MermaidBlock code="graph TD; A--" onCodeChange={() => true} />);
        expect(await screen.findByText('Parse error on line 1')).toBeInTheDocument();
        rerender(<MermaidBlock code="graph TD; A-->B" onCodeChange={() => true} />);
        await waitFor(() => expect(screen.getByTestId('diagram')).toBeInTheDocument());
        expect(screen.queryByText('Parse error on line 1')).toBeNull();
        expect(renderSpy).toHaveBeenCalledTimes(2);
    });
});
