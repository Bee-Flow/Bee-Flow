import { render, screen, fireEvent } from '@testing-library/react';
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import RibbonDropdown from './RibbonDropdown';

describe('RibbonDropdown', () => {
    it('puts buttonProps on the pill button itself', () => {
        render(
            <RibbonDropdown label="Flow control" open={false} onToggle={() => {}} buttonProps={{ 'data-ribbon-origin': 'section:flow_control', 'data-x': '1' }}>
                <div>menu</div>
            </RibbonDropdown>,
        );
        const btn = screen.getByRole('button', { name: /Flow control/ });
        expect(btn.getAttribute('data-ribbon-origin')).toBe('section:flow_control');
        expect(btn.getAttribute('data-x')).toBe('1');
    });

    it('works without buttonProps, and still toggles', () => {
        const onToggle = vi.fn();
        render(<RibbonDropdown label="Apps" open={false} onToggle={onToggle}><div>menu</div></RibbonDropdown>);
        const btn = screen.getByRole('button', { name: /Apps/ });
        expect(btn.hasAttribute('data-ribbon-origin')).toBe(false);
        fireEvent.click(btn);
        expect(onToggle).toHaveBeenCalledTimes(1);
    });
});
