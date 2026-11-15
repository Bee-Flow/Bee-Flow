// Models (admin dashboard): the server's own chat tiers, read-only, above the
// organisation's custom tiers. The page says it shows the organisation's tiers
// "next to the tiers of the whole server": this is that second half, so an
// organisation admin can read which model sits behind each tier without being
// able to change it (the platform administrator sets them in AI configuration).
import { useQuery } from '@tanstack/react-query';
import { RefusedError } from '@/api/mutate';
import { apiRequest } from '@/api/typedRequest';
import { useTranslation } from '@/hooks/useTranslation';
import { shortModelName } from '@/utils/modelNames';
import { SettingRow, SettingsGroup, SettingsList } from '@/components/shared/SettingsList';
import type { AvailableModel } from './useCustomTiersRead';

/** The tiers the chat picker offers everyone, in its order; `pro` is named as Deep Thinking (tier.js). */
const SERVER_TIERS: readonly { key: string; nameKey: string; icon: string }[] = [
    { key: 'fast', nameKey: 'tier.fast', icon: '⚡' },
    { key: 'thinking', nameKey: 'tier.thinking', icon: '🧠' },
    { key: 'writer', nameKey: 'tier.writer', icon: '✍️' },
    { key: 'pro', nameKey: 'tier.deep_thinking', icon: '✨' },
];

type ServerTierMap = Record<string, { modelId?: string } | undefined>;

/** One tier map; a refusal (or an odd answer) reads as "nothing configured". */
async function readTierMap(path: 'GET /ai/config/chat-models' | 'GET /ai/config/chat-models-eu'): Promise<ServerTierMap> {
    const res = await apiRequest(path).catch((err: unknown) => {
        if (err instanceof RefusedError) return null;
        throw err;
    });
    if (!res) return {};
    const body: unknown = await res.json();
    if (!body || typeof body !== 'object') return {};
    // An older answer wrapped the map in `tiers`.
    const map = 'tiers' in body && body.tiers && typeof body.tiers === 'object' ? body.tiers : body;
    return map as ServerTierMap;
}

/** The server's tier maps: the main one, and the EU one an organisation in EU mode gets instead. */
async function readServerTiers(): Promise<{ main: ServerTierMap; eu: ServerTierMap }> {
    const [main, eu] = await Promise.all([readTierMap('GET /ai/config/chat-models'), readTierMap('GET /ai/config/chat-models-eu')]);
    return { main, eu };
}

/** The server's tiers that have a model, each with its model's name. */
export default function OrgServerTiersList({ models }: { models: readonly AvailableModel[] }) {
    const { t } = useTranslation();
    const query = useQuery({ queryKey: ['ai-config', 'chat-models'], queryFn: readServerTiers, staleTime: 60_000 });
    if (!query.data) return null;
    const nameOf = (modelId: string) => models.find((m) => m.id === modelId)?.name || shortModelName(modelId);
    const rows = SERVER_TIERS.flatMap((tier) => {
        const modelId = query.data.main[tier.key]?.modelId;
        if (!modelId) return [];
        const euId = query.data.eu[tier.key]?.modelId;
        return [{ ...tier, modelName: nameOf(modelId), euName: euId && euId !== modelId ? nameOf(euId) : null }];
    });
    if (rows.length === 0) return null;
    return (
        <SettingsGroup
            title={t('admin_polish.tiers_server_title', 'Tiers of the whole server')}
            description={t('admin_polish.tiers_server_desc', 'These tiers come with the server. The platform administrator chooses their models: you can read them here, not change them. A group can still limit which tiers its members get.')}
        >
            <div data-testid="server-tiers">
                <SettingsList>
                    {rows.map((row) => (
                        <SettingRow key={row.key} inline icon={row.icon} label={t(row.nameKey, row.key)}>
                            <span className="text-xs text-[var(--text-secondary)]">
                                {row.euName
                                    ? t('admin_polish.tiers_server_model_eu', '{model} · in EU mode: {eu}', { model: row.modelName, eu: row.euName })
                                    : row.modelName}
                            </span>
                        </SettingRow>
                    ))}
                </SettingsList>
            </div>
        </SettingsGroup>
    );
}
