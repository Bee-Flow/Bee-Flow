import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import TokenColorField from './TokenColorField';
import { colourTokensOf } from './colourTokens';

// The colour control offers the app's colour tokens (design.tokens) beside the roles and a custom
// hex: a token value opens on its own tab instead of an empty "Custom" picker.
const definition = { design: { tokens: { 'brand-soft': '#e0f2fe', 'brand-ink': '#0c4a6e', gutter: 24 } } };

describe('TokenColorField with colour tokens', () => {
    it('lists the colour tokens of a definition, not the spacing ones', () => {
        expect(colourTokensOf(definition)).toEqual([{ name: 'brand-ink', hex: '#0c4a6e' }, { name: 'brand-soft', hex: '#e0f2fe' }]);
        expect(colourTokensOf({})).toEqual([]);
    });

    it('opens a token value on the Token tab with the token checked, and commits token:<name>', async () => {
        const onChange = vi.fn();
        render(<TokenColorField value="token:brand-soft" onChange={onChange} tokens={colourTokensOf(definition)} />);
        expect(screen.getByRole('radio', { name: 'brand-soft' })).toHaveAttribute('aria-checked', 'true');
        await userEvent.click(screen.getByRole('radio', { name: 'brand-ink' }));
        expect(onChange).toHaveBeenCalledWith('token:brand-ink');
    });

    it('offers no Token tab to an app without colour tokens', () => {
        render(<TokenColorField value="#112233" onChange={() => {}} />);
        expect(screen.queryByText('Token')).toBeNull();
        expect(screen.getByText('Custom')).toBeInTheDocument();
    });

    it('says so when the stored token is not a colour token of the app', () => {
        render(<TokenColorField value="token:gone" onChange={() => {}} tokens={colourTokensOf(definition)} />);
        expect(screen.getByText(/"gone" is not a colour token/)).toBeInTheDocument();
    });
});
