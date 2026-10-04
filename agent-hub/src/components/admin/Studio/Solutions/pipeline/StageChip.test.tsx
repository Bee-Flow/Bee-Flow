import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import StageChip from './StageChip';

describe('StageChip', () => {
    it('shows the stage name as text, never colour alone', () => {
        render(<StageChip stage="uat" />);
        expect(screen.getByText('UAT')).toBeInTheDocument();
        expect(screen.getByTestId('stage-chip-uat')).toHaveAttribute('data-active', 'false');
    });

    it('takes a custom label and marks the active chip', () => {
        render(<StageChip stage="prd" label="Production R2" active />);
        expect(screen.getByText('Production R2')).toBeInTheDocument();
        expect(screen.getByTestId('stage-chip-prd')).toHaveAttribute('data-active', 'true');
    });
});
