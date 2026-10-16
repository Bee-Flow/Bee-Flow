import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ShareImageSettings, { readShareImage } from './ShareImageSettings';

describe('ShareImageSettings', () => {
    it('reads the stored setting with the server defaults', () => {
        expect(readShareImage({})).toEqual({ template: 'light', motif: true });
        expect(readShareImage({ shareImage: { template: 'brand', motif: false } })).toEqual({ template: 'brand', motif: false });
        expect(readShareImage({ shareImage: { template: 'nonsense' } })).toEqual({ template: 'light', motif: true });
    });

    it('changes the card style and the motif without touching the rest of the design', async () => {
        const onChange = vi.fn();
        const user = userEvent.setup();
        render(<ShareImageSettings design={{ radius: 12 }} onChange={onChange} />);
        await user.selectOptions(screen.getByLabelText('Card style'), 'dark');
        expect(onChange).toHaveBeenLastCalledWith({ radius: 12, shareImage: { template: 'dark', motif: true } });
        await user.click(screen.getByLabelText('Honeycomb pattern'));
        expect(onChange).toHaveBeenLastCalledWith({ radius: 12, shareImage: { template: 'light', motif: false } });
    });
});
