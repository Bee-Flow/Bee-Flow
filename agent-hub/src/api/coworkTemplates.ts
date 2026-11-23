// Templates from your organisation (server/usecases/coworkTemplates.mts): the coworks colleagues saved to start from,
// one of them with what its plan may do (worked out by the server each time), adding one, and saving an item as one.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiJson, apiUrl } from './typedRequest';
import type { PlanDraft, PlanPermissions } from './coworkPlan.types';

export interface TemplateCard { id: string; title: string; brief: string; repeatInterval: string | null; hasPlan: boolean; createdAt: string | null; mine: boolean }
interface TemplatePlan { view: PlanDraft['view']; permissions: PlanPermissions; findings: PlanDraft['findings']; attachable: boolean }
export interface TemplateView { template: TemplateCard & { savedBy: string | null; canDelete: boolean }; plan: TemplatePlan | null }
export interface UsedTemplate { item: { id: string }; planAttached: boolean; findings: PlanDraft['findings'] }
export interface SavedTemplate { template: TemplateCard; warnings: string[] }

const LIST_KEY = ['cowork', 'templates'] as const;

export function useCoworkTemplates(enabled: boolean) {
    return useQuery<TemplateCard[], Error>({
        queryKey: LIST_KEY,
        enabled,
        queryFn: async () => (await apiJson<'GET /api/cowork/templates', { templates?: TemplateCard[] }>('GET /api/cowork/templates')).templates ?? [],
        staleTime: 30_000,
        retry: false,
    });
}

export function useCoworkTemplate(id: string | null) {
    return useQuery<TemplateView, Error>({
        queryKey: [...LIST_KEY, id],
        enabled: !!id,
        queryFn: () => apiJson<'GET /api/cowork/templates/{id}', TemplateView>('GET /api/cowork/templates/{id}', { params: { id: String(id) } }),
        retry: false,
    });
}

/** Add a template to my cowork: a new, paused item, its plan not approved. */
export function useAddCoworkTemplate() {
    const client = useQueryClient();
    return useMutation<UsedTemplate, Error, string>({
        mutationFn: (id) => apiJson<'POST /api/cowork/templates/{id}/use', UsedTemplate>('POST /api/cowork/templates/{id}/use', { params: { id }, body: {} }),
        onSuccess: () => { void client.invalidateQueries({ queryKey: ['cowork', 'list'] }); },
    });
}

export function useDeleteCoworkTemplate() {
    const client = useQueryClient();
    return useMutation<unknown, Error, string>({
        mutationFn: (id) => apiJson<'DELETE /api/cowork/templates/{id}', unknown>('DELETE /api/cowork/templates/{id}', { params: { id } }),
        onSuccess: () => { void client.invalidateQueries({ queryKey: LIST_KEY }); },
    });
}

/** Save one of my items as a template of my organisation. */
export function useSaveCoworkTemplate(coworkId: string) {
    const client = useQueryClient();
    return useMutation<SavedTemplate, Error, string | undefined>({
        mutationFn: (title) => apiJson<'POST /api/cowork/{id}/save-as-template', SavedTemplate>('POST /api/cowork/{id}/save-as-template', {
            params: { id: coworkId }, body: title ? { title } : {},
        }),
        onSuccess: () => { void client.invalidateQueries({ queryKey: LIST_KEY }); },
    });
}

// ── Packages (server/usecases/coworkPackages.mts): a template as a signed file ────────────────────────────────────

export interface PackagePreview {
    title: string;
    brief: string;
    repeatInterval: string | null;
    plan: TemplatePlan | null;
    signedBy: { keyId: string; thisInstallation: boolean };
}

/** Where a template downloads as a package file, signed by this installation. */
export const packageUrl = (id: string): string => apiUrl('GET /api/cowork/templates/{id}/package', { params: { id } });

/** What a package file holds and may do, after the server checked its signature. */
export function usePreviewPackage() {
    return useMutation<PackagePreview, Error, Record<string, unknown>>({
        mutationFn: (pkg) => apiJson<'POST /api/cowork/packages/preview', PackagePreview>('POST /api/cowork/packages/preview', { body: { package: pkg } }),
    });
}

/** Add a package file to my cowork: a new, paused item, its plan not approved. */
export function useAddPackage() {
    const client = useQueryClient();
    return useMutation<UsedTemplate, Error, Record<string, unknown>>({
        mutationFn: (pkg) => apiJson<'POST /api/cowork/packages/add', UsedTemplate>('POST /api/cowork/packages/add', { body: { package: pkg } }),
        onSuccess: () => { void client.invalidateQueries({ queryKey: ['cowork', 'list'] }); },
    });
}
