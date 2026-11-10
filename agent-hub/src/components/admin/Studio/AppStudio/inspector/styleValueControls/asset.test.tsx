import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { withQueryClient } from '@/test/queryWrapper';
import AssetKnobControl from './asset';
import { STYLE_VALUE_CONTROLS } from '../styleValueControls';

describe('asset style value control', () => {
    it('is the control registered for the asset value type', () => {
        expect(STYLE_VALUE_CONTROLS.asset).toBe(AssetKnobControl);
    });

    it('shows the picked file with a remove button, and removing clears the knob', async () => {
        const onChange = vi.fn();
        const { container } = render(withQueryClient(
            <AssetKnobControl knob="backgroundImage" spec={{ type: 'asset' }} value="asset:abc" onChange={onChange} definition={{} as never} disabled={false} />,
        ));
        expect(container.querySelector('[data-asset-ref="asset:abc"]')).toBeTruthy();
        await userEvent.click(screen.getByRole('button', { name: 'Remove' }));
        expect(onChange).toHaveBeenCalledWith(null);
    });

    it('offers only the uploaded files when nothing is set', () => {
        render(withQueryClient(
            <AssetKnobControl knob="backgroundImage" spec={{ type: 'asset' }} value={null} onChange={vi.fn()} definition={{} as never} disabled={false} />,
        ));
        expect(screen.queryByRole('textbox')).toBeNull();
        expect(screen.getByRole('button', { name: 'Choose an uploaded file' })).toBeTruthy();
    });
});
