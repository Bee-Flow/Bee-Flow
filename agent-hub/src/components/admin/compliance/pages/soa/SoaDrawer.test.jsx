import React from 'react';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import SoaDrawer from './SoaDrawer';
import { indexChecks } from './soaThemes';

vi.mock('../../../../../hooks/useTranslation', () => {
    const useTranslation = () => ({
        t: (key, fallback, params) => {
            let out = typeof fallback === 'string' ? fallback : key;
            for (const [k, v] of Object.entries(params || {})) out = out.split(`{${k}}`).join(String(v));
            return out;
        },
        locale: 'en',
        resolvedLocale: 'en',
    });
    return { default: useTranslation, useTranslation };
});

afterEach(cleanup);

const USERS = [{ id: 'u1', displayName: 'T. Smit', email: 'tom@example.com' }, { id: 'u2', displayName: 'R. Bakker', email: 'r@example.com' }];

const control = (over = {}) => ({
    ref: 'A.5.20',
    titleKey: 'k.5.20',
    objectiveKey: 'o.5.20',
    checks: ['ISO-A5-20'],
    entry: { status: 'todo', applicable: true, justification: '', how_met: 'DPA per processor', owner_user_id: 'u2', updated_at: '2026-06-10T09:00:00Z', updated_by: null },
    ...over,
});

const byId = (status) => indexChecks([{ check_id: 'ISO-A5-20', status, regulation: 'GDPR', article: '28', titleKey: 'chk.title', last_run_at: '2026-09-14T07:12:00Z' }]);

describe('SoaDrawer — the approved rule', () => {
    it('disables "Approved" with the hint while the linked check is warn', () => {
        render(<SoaDrawer control={control()} checksById={byId('warn')} orgUsers={USERS} onSave={vi.fn()} onClose={vi.fn()} navigate={vi.fn()} />);
        const approved = screen.getByTestId('soa-drawer-decision-approved');
        expect(approved).toBeDisabled();
        expect(approved.getAttribute('aria-disabled')).toBe('true');
        expect(screen.getByTestId('soa-drawer-approved-hint').textContent).toMatch(/not possible while the linked check needs attention/);
        expect(screen.getByTestId('soa-drawer-check').getAttribute('data-status')).toBe('warn');
    });

    it('lets the reviewer approve when the linked check passes and saves the allow-listed patch', () => {
        const onSave = vi.fn();
        render(<SoaDrawer control={control()} checksById={byId('pass')} orgUsers={USERS} onSave={onSave} onClose={vi.fn()} navigate={vi.fn()} />);
        const approved = screen.getByTestId('soa-drawer-decision-approved');
        expect(approved).not.toBeDisabled();
        expect(screen.queryByTestId('soa-drawer-approved-hint')).toBeNull();
        fireEvent.click(approved);
        expect(approved.getAttribute('aria-checked')).toBe('true');
        fireEvent.click(screen.getByTestId('soa-drawer-save'));
        expect(onSave).toHaveBeenCalledWith('A.5.20', {
            status: 'approved', applicable: true, justification: null, how_met: 'DPA per processor', owner_user_id: 'u2',
        });
    });

    it('names the check status in words — including "not applicable", which has its own key', () => {
        render(<SoaDrawer control={control()} checksById={byId('not_applicable')} orgUsers={USERS} onSave={vi.fn()} onClose={vi.fn()} navigate={vi.fn()} />);
        const box = screen.getByTestId('soa-drawer-check');
        expect(box.textContent).toMatch(/Linked live check · Not applicable/);
        expect(box.textContent).not.toMatch(/not_applicable/);
        cleanup();
        render(<SoaDrawer control={control()} checksById={byId('fail')} orgUsers={USERS} onSave={vi.fn()} onClose={vi.fn()} navigate={vi.fn()} />);
        expect(screen.getByTestId('soa-drawer-check').textContent).toMatch(/Linked live check · Failing/);
        expect(screen.getByTestId('soa-drawer-decision-approved')).toBeDisabled();
    });

    it('"Check ↗" navigates to the section that scores the check\'s regulation, with the check id', () => {
        const navigate = vi.fn();
        render(<SoaDrawer control={control()} checksById={byId('pass')} orgUsers={USERS} onSave={vi.fn()} onClose={vi.fn()} navigate={navigate} />);
        fireEvent.click(screen.getByTestId('soa-drawer-check-open'));
        expect(navigate).toHaveBeenCalledWith('gdpr', 'ISO-A5-20');
    });
});

describe('SoaDrawer — the justification rule', () => {
    it('Save is disabled for "Excluded" until a justification is written, then sends applicable:false', () => {
        const onSave = vi.fn();
        render(<SoaDrawer control={control()} checksById={byId('pass')} orgUsers={USERS} onSave={onSave} onClose={vi.fn()} navigate={vi.fn()} />);
        fireEvent.click(screen.getByTestId('soa-drawer-decision-excluded'));
        const save = screen.getByTestId('soa-drawer-save');
        expect(save).toBeDisabled();
        expect(screen.getByTestId('soa-drawer-justification-hint')).toBeTruthy();
        fireEvent.change(screen.getByTestId('soa-drawer-justification'), { target: { value: '   ' } });
        expect(save).toBeDisabled();
        fireEvent.change(screen.getByTestId('soa-drawer-justification'), { target: { value: 'Fully cloud — no server room of our own.' } });
        expect(save).not.toBeDisabled();
        fireEvent.click(save);
        expect(onSave).toHaveBeenCalledWith('A.5.20', expect.objectContaining({ applicable: false, status: 'todo', justification: 'Fully cloud — no server room of our own.' }));
    });

    it('an already-excluded row opens with "Excluded" selected and its stored status is kept when re-included', () => {
        const onSave = vi.fn();
        const c = control({ entry: { status: 'reviewed', applicable: false, justification: 'cloud only', how_met: null, owner_user_id: null, updated_at: '2026-06-12T09:00:00Z', updated_by: 'u1' } });
        render(<SoaDrawer control={c} checksById={byId('pass')} orgUsers={USERS} onSave={onSave} onClose={vi.fn()} navigate={vi.fn()} />);
        expect(screen.getByTestId('soa-drawer-decision-excluded').getAttribute('aria-checked')).toBe('true');
        expect(screen.getByTestId('soa-drawer-stamp').textContent).toMatch(/Last changed .* by T\. Smit/);
        fireEvent.click(screen.getByTestId('soa-drawer-decision-reviewed'));
        fireEvent.click(screen.getByTestId('soa-drawer-save'));
        expect(onSave).toHaveBeenCalledWith('A.5.20', expect.objectContaining({ applicable: true, status: 'reviewed' }));
    });
});

describe('SoaDrawer — owner and stamps', () => {
    it('shows the owner by display name (never the e-mail) and clears it', () => {
        render(<SoaDrawer control={control()} checksById={byId('pass')} orgUsers={USERS} onSave={vi.fn()} onClose={vi.fn()} navigate={vi.fn()} />);
        expect(screen.getByTestId('soa-drawer-owner').textContent).toBe('R. Bakker');
        expect(screen.getByTestId('soa-drawer-owner').textContent).not.toMatch(/@/);
        fireEvent.click(screen.getByLabelText('Remove owner'));
        expect(screen.getByTestId('soa-drawer-owner').textContent).toBe('No owner assigned');
    });

    it('a template row reads "Added … (template) · never changed."; a row without an entry says saving creates it', () => {
        const { unmount } = render(<SoaDrawer control={control()} checksById={byId('pass')} orgUsers={USERS} onSave={vi.fn()} onClose={vi.fn()} navigate={vi.fn()} />);
        expect(screen.getByTestId('soa-drawer-stamp').textContent).toMatch(/\(template\) · never changed/);
        unmount();
        render(<SoaDrawer control={control({ entry: null })} checksById={byId('pass')} orgUsers={USERS} onSave={vi.fn()} onClose={vi.fn()} navigate={vi.fn()} />);
        expect(screen.getByTestId('soa-drawer-stamp').textContent).toMatch(/No row yet/);
    });
});
