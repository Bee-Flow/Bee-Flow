/** Contract readers for the Azure configuration (model/azureTypes.ts). */

import { field, pick, shapeOf } from '@/core/api/contract';

import type { AzureConfig, AzureGroupSyncSettings, AzureSyncResult, AzureTier } from '../model/azureTypes';

const readTierFields = shapeOf({
    modelId: field.str(''),
    label: field.str(''),
    maxTokens: field.numOrNull,
    temperature: field.numOrNull,
    reasoningEffort: field.strOrNull,
    reasoningSummary: field.bool(false),
});

function readTiers(raw: unknown): Record<string, AzureTier> {
    const out: Record<string, AzureTier> = {};
    const map = field.record<Record<string, unknown>>({})(raw);
    for (const [key, value] of Object.entries(map)) {
        out[key] = { ...readTierFields(value), raw: field.record<Record<string, unknown>>({})(value) };
    }
    return out;
}

export const readAzureSyncSettings: (raw: unknown) => AzureGroupSyncSettings = shapeOf({
    destructiveSync: field.bool(false),
    autoActivateUsers: field.bool(true),
    periodicSync: field.bool(false),
    syncIntervalHours: field.num(6),
});

export const readAzureConfig: (raw: unknown) => AzureConfig = shapeOf({
    azureEndpoint: field.str(''),
    hasAzureApiKey: field.bool(false),
    azureApiVersion: field.str('2024-04-01-preview'),
    azureModels: field.str(''),
    chatModelTiers: readTiers,
    useAzureDocProcessing: field.bool(false),
    azureDocEndpoint: field.str(''),
    hasAzureDocEndpoint: field.bool(false),
    hasAzureDocKey: field.bool(false),
    azureEmbedEndpoint: field.str(''),
    hasAzureEmbedEndpoint: field.bool(false),
    hasAzureEmbedKey: field.bool(false),
    azureEmbedModel: field.str('text-embedding-3-small'),
    ssoClientId: field.str(''),
    hasSsoClientSecret: field.bool(false),
    ssoTenantId: field.str('common'),
    autoApproveSSO: field.bool(false),
    groupSyncSettings: readAzureSyncSettings,
    groupSyncStatus: shapeOf({
        lastSyncAt: field.strOrNull,
        lastSyncResult: field.strOrNull,
        syncedGroups: field.num(0),
        syncedUsers: field.num(0),
    }),
});

export function readAzureSyncResult(raw: unknown): AzureSyncResult {
    const synced = pick(raw, 'synced');
    return {
        ok: field.bool(false)(pick(raw, 'ok')),
        groups: field.num(0)(pick(synced, 'groups')),
        users: field.num(0)(pick(synced, 'users')),
        errors: field.strArray(pick(raw, 'errors')),
        details: field.strArray(pick(raw, 'details')),
    };
}
