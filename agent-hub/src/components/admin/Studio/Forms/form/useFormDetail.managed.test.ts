import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

const api = vi.hoisted(() => ({ getForm: vi.fn(), updateAutomation: vi.fn() }));
vi.mock('../../../../../hooks/useAutomationApi', () => ({ default: () => api }));

import useFormDetail from './useFormDetail';

const FORM = { automationId: 'a1', definition: { trigger: { form: { pages: [] } } } };
const MANAGED = { solutionId: 's1', solutionName: 'Intake', stage: 'prd', releaseSeq: 7, devRef: null };
const refusal = Object.assign(new Error('This part is managed by a Solution stage. Change it in Dev and deploy.'), {
    status: 409,
    code: 'managed_part',
    managed: {
        reason: 'managed', code: 'managed_part', message: 'x',
        managed: { solutionId: 's2', solutionName: null, stage: 'uat', releaseSeq: null, devRef: null },
    },
});

beforeEach(() => { api.getForm.mockReset(); api.updateAutomation.mockReset(); });

describe('useFormDetail and a Solution stage', () => {
    it('an ordinary form is not read-only', async () => {
        api.getForm.mockResolvedValue({ form: FORM });
        const { result } = renderHook(() => useFormDetail('a1'));
        await waitFor(() => expect(result.current.loading).toBe(false));
        expect(result.current).toMatchObject({ managed: null, refusal: null, readOnly: false });
    });

    it('reads `managed` off the form when the GET says so', async () => {
        api.getForm.mockResolvedValue({ form: { ...FORM, managed: MANAGED } });
        const { result } = renderHook(() => useFormDetail('a1'));
        await waitFor(() => expect(result.current.managed).toEqual(MANAGED));
        expect(result.current.readOnly).toBe(true);
    });

    it('maps the 409 managed_part of a save to the banner state and keeps the draft', async () => {
        api.getForm.mockResolvedValue({ form: FORM });
        api.updateAutomation.mockRejectedValue(refusal);
        const { result } = renderHook(() => useFormDetail('a1'));
        await waitFor(() => expect(result.current.loading).toBe(false));
        act(() => result.current.setDraft({ pages: [{ id: 'p1' }] } as never));

        await act(async () => { await result.current.save().catch(() => {}); });
        expect(result.current.saveError).toBe(refusal);
        expect((result.current.refusal as { reason: string } | null)?.reason).toBe('managed');
        expect(result.current.managed?.solutionId).toBe('s2');
        expect(result.current.readOnly).toBe(true);
        expect(result.current.draft).toEqual({ pages: [{ id: 'p1' }] });
    });

    it('any other failed save is just a failed save', async () => {
        api.getForm.mockResolvedValue({ form: FORM });
        api.updateAutomation.mockRejectedValue(Object.assign(new Error('boom'), { status: 500 }));
        const { result } = renderHook(() => useFormDetail('a1'));
        await waitFor(() => expect(result.current.loading).toBe(false));
        await act(async () => { await result.current.save().catch(() => {}); });
        expect(result.current).toMatchObject({ refusal: null, managed: null, readOnly: false });
        expect((result.current.saveError as Error | null)?.message).toBe('boom');
    });
});
