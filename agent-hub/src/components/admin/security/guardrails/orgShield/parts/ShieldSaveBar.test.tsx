/**
 * The Privacy Shield save bar.
 *
 * Run: npx vitest run src/components/admin/security/guardrails/orgShield/parts/ShieldSaveBar.test.tsx
 */
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Gauge, Replace } from 'lucide-react';
import React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { ShieldSaveBar } from './ShieldSaveBar';
import type { TranslateFn } from '../../../../../../hooks/useTranslation';

const t: TranslateFn = (key, fallbackOrParams, paramsArg) => {
    const fallback = typeof fallbackOrParams === 'string' ? fallbackOrParams : key;
    const params = typeof fallbackOrParams === 'object' ? fallbackOrParams : paramsArg;
    return Object.entries(params || {}).reduce((out, [k, v]) => out.split(`{${k}}`).join(String(v)), fallback);
};

const base = { saving: false, canSave: true, onSave: vi.fn(), t };

describe('ShieldSaveBar', () => {
    it('looks idle when clean but still saves: a clean re-save migrates legacy terms', async () => {
        const user = userEvent.setup();
        const onSave = vi.fn();
        render(<ShieldSaveBar {...base} isDirty={false} onSave={onSave} />);
        expect(screen.getByText('No unsaved changes')).toBeInTheDocument();
        const save = screen.getByRole('button', { name: 'Save changes' });
        expect(save).toBeEnabled();
        await user.click(save);
        expect(onSave).toHaveBeenCalledTimes(1);
        expect(screen.queryByRole('button', { name: 'Discard' })).toBeNull();
    });

    it('names the steps holding edits, as chips that go there', async () => {
        const user = userEvent.setup();
        const onGoTo = vi.fn();
        render(
            <ShieldSaveBar
                {...base}
                isDirty
                onDiscard={vi.fn()}
                onGoTo={onGoTo}
                dirtyStages={[
                    { id: 'detection', label: 'What we look for', Icon: Gauge, count: 2 },
                    { id: 'processing', label: 'When we find something', Icon: Replace, count: 0 },
                ]}
            />,
        );
        expect(screen.getByText('Unsaved changes')).toBeInTheDocument();
        expect(screen.getByText('on 2 steps:')).toBeInTheDocument();
        await user.click(screen.getByRole('button', { name: /^What we look for\s*· 2$/ }));
        expect(onGoTo).toHaveBeenCalledWith('detection');
        expect(screen.getByRole('button', { name: 'Discard' })).toBeInTheDocument();
    });

    it('says "step" for one step', () => {
        render(
            <ShieldSaveBar
                {...base}
                isDirty
                dirtyStages={[{ id: 'detection', label: 'What we look for', Icon: Gauge, count: 1 }]}
            />,
        );
        expect(screen.getByText('on 1 step:')).toBeInTheDocument();
    });

    it('disables Save while saving, and says so', () => {
        render(<ShieldSaveBar {...base} isDirty saving />);
        expect(screen.getByRole('button', { name: 'Saving...' })).toBeDisabled();
    });

    it('reports a partial save as a note, not a failure', () => {
        render(<ShieldSaveBar {...base} isDirty={false} message={{ type: 'warning', text: 'Saved, with notes.' }} />);
        expect(screen.getByRole('status')).toHaveTextContent('Saved, with notes.');
        expect(screen.getByRole('status').className).toContain('--warning-ink');
    });
});
