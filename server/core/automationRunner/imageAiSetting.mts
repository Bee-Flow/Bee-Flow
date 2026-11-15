/**
 * The organisation setting "images to AI in automations": may an `ai_step` or
 * `data_extraction` step show the picture itself to the AI model, or only the
 * text read from it (OCR)?
 *
 * Off by default. Turning it on is a processing decision (the pixels of a
 * receipt or a photographed document reach the model provider, and nothing
 * can scan pixels for personal data the way the Privacy Shield scans text),
 * so only an admin of the organisation changes it (routes/orgAutomationImageAi.mts).
 *
 *   - stored under `org_automation_image_ai_<orgId>` in configStore;
 *   - MISSING or malformed reads as OFF, and so does a failed read: the run
 *     then falls back to the OCR text, which is what an organisation that
 *     never chose gets anyway;
 *   - memoised for CACHE_TTL_MS per organisation (every image step of every
 *     run asks); a save drops the memo.
 */

import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);

export type ConfigStore = {
    getConfig: (key: string) => Promise<unknown>;
    setConfig: (key: string, value: unknown) => Promise<unknown>;
};

const configStore = (): ConfigStore => nodeRequire('../../stores/configStore') as ConfigStore;
const log = nodeRequire('../../telemetry/log') as { warn: (msg: string) => void };
const { AUTOMATION_IMAGE_AI_CONFIG_KEY_PREFIX } = nodeRequire('../../stores/lib/orgConfigKeyPrefixes') as { AUTOMATION_IMAGE_AI_CONFIG_KEY_PREFIX: string };

export const CONFIG_KEY_PREFIX: string = AUTOMATION_IMAGE_AI_CONFIG_KEY_PREFIX;
const CACHE_TTL_MS = 30_000;

export interface ImageAiSetting {
    /** Images may reach a model that can see them. */
    enabled: boolean;
    /** Saved at least once (lets a screen tell "never set" from "explicitly off"). */
    configured: boolean;
}

const OFF: Readonly<ImageAiSetting> = Object.freeze({ enabled: false, configured: false });
const memo = new Map<string, { at: number; setting: ImageAiSetting }>();

export function imageAiConfigKey(orgId: string): string {
    return `${CONFIG_KEY_PREFIX}${orgId}`;
}

/** A stored row (or nothing) as the setting: only a literal `enabled: true` turns it on. */
export function normalizeImageAiSetting(stored: unknown): ImageAiSetting {
    const enabled = !!stored && typeof stored === 'object' && (stored as { enabled?: unknown }).enabled === true;
    return { enabled, configured: stored !== null && stored !== undefined };
}

/** The stored row, read fresh (throws when the store does): what a settings screen shows. */
export async function readImageAiSetting(orgId: string, store: Pick<ConfigStore, 'getConfig'> = configStore()): Promise<ImageAiSetting> {
    return normalizeImageAiSetting(await store.getConfig(imageAiConfigKey(orgId)));
}

/**
 * The setting for a run. Never throws: no organisation, a missing row or a
 * failed read is OFF.
 */
export async function resolveImageAiSetting(orgId: string | null | undefined, store?: Pick<ConfigStore, 'getConfig'>): Promise<ImageAiSetting> {
    if (!orgId) return OFF;
    const hit = memo.get(orgId);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.setting;
    let setting: ImageAiSetting = OFF;
    try {
        setting = await readImageAiSetting(orgId, store);
    } catch (err) {
        log.warn(`[ImageAiSetting] could not read the setting of org ${orgId}: ${(err as Error).message}`);
    }
    memo.set(orgId, { at: Date.now(), setting });
    return setting;
}

/** Just the boolean, for the run path. */
export async function imageAiEnabled(orgId: string | null | undefined): Promise<boolean> {
    return (await resolveImageAiSetting(orgId)).enabled;
}

/** Save the switch for an organisation (the caller checked it is an org admin). */
export async function saveImageAiSetting(orgId: string, enabled: boolean, updatedBy: string | null, store: Pick<ConfigStore, 'setConfig'> = configStore()): Promise<ImageAiSetting> {
    await store.setConfig(imageAiConfigKey(orgId), { enabled, updatedAt: new Date().toISOString(), updatedBy });
    memo.delete(orgId);
    return { enabled, configured: true };
}

/** Drop the memo (tests, and a save from elsewhere). */
export function invalidateImageAiSetting(orgId?: string): void {
    if (orgId) memo.delete(orgId); else memo.clear();
}
