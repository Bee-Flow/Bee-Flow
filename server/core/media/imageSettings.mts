/**
 * What a client needs to offer image generation to one user: the models they
 * can pick, whether there is any, and (when an image limit applies to them)
 * the limits and what is used. Part of GET /ai/user-settings.
 */

import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);

type ImageModelChoice = { id: string; label: string; provider: 'google' | 'azure' };
type Quota = { limits: Record<string, number>; used: Record<string, number> } | null;

const imageModels = () => nodeRequire('./imageModels.mts') as { listImageModels(): Promise<ImageModelChoice[]> };
const imageQuota = () => nodeRequire('../entitlements/imageQuota.mts') as { getImageQuota(userId: string): Promise<Quota> };
const bestEffort = () => nodeRequire('../../utils/bestEffort') as { fallback<T>(label: string, err: unknown, value: T): T };

export async function imageSettingsFor(userId: string): Promise<{ imageModels: ImageModelChoice[]; hasImageGen: boolean; imageQuota: Quota }> {
    const models = await imageModels().listImageModels();
    // Best effort: the composer must still load when the count cannot be read
    // (the generation itself checks again, and fails closed).
    const quota = models.length > 0
        ? await imageQuota().getImageQuota(userId).catch((err) => bestEffort().fallback('core/media/imageSettings:quota', err, null))
        : null;
    return { imageModels: models, hasImageGen: models.length > 0, imageQuota: quota };
}
