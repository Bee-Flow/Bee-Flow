// The tools each tier of direct chat may call, as the server holds them
// (direct_chat_tier_tools, read by core/tools/directChatToolStack.js), and the
// tool parameters pinned per tier (direct_chat_tier_tool_params). No screen
// wrote or showed them, so a restriction stayed active without anyone seeing
// it. Read-only here; the one action puts every tier back on the default tools.
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { TIERS } from './chatModelTiers/constants';
import { readOrNull } from '@/api/queries/refusableRead';
import { apiRequest, apiUrl } from '@/api/typedRequest';
import { ApiError } from '@/api/mutate';
import { Button } from '@/components/shared/Button';
import { CHIP, CHIP_WARNING } from '@/components/shared/adminUi';
import { SettingRow, SettingsGroup, SettingsList } from '@/components/shared/SettingsList';
import toast from '@/components/shared/Toast';
import useConfirm from '@/components/shared/useConfirm';
import { useTranslation } from '@/hooks/useTranslation';

/** tier → the component ids it may call. */
type TierTools = Record<string, string[]>;
/** tier → tool → the parameters pinned for it. */
type TierToolParams = Record<string, Record<string, Record<string, unknown>>>;

interface MatrixRead {
    tools: TierTools;
    params: TierToolParams;
}

const matrixKey = ['admin-config', 'direct-chat-tier-tools'] as const;

const asRecord = <T,>(value: unknown): Record<string, T> =>
    (value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, T> : {});

async function readMatrix(signal: AbortSignal): Promise<MatrixRead> {
    const [tools, params] = await Promise.all([
        readOrNull<unknown>(apiUrl('GET /ai/config/direct-chat-tools'), signal),
        readOrNull<unknown>(apiUrl('GET /ai/config/direct-chat-tool-params'), signal),
    ]);
    const lists = asRecord<unknown>(tools);
    return {
        tools: Object.fromEntries(Object.entries(lists).filter(([, ids]) => Array.isArray(ids)).map(([tier, ids]) => [tier, (ids as unknown[]).map(String)])),
        params: asRecord<Record<string, Record<string, unknown>>>(params),
    };
}

/** The tiers to show: the standard ones in their order, then any other key the server holds (a custom tier). */
function tierRows(read: MatrixRead): { key: string; label: string }[] {
    const known = TIERS.map(tier => ({ key: tier.key, label: tier.label }));
    const extra = [...Object.keys(read.tools), ...Object.keys(read.params)]
        .filter((k, i, all) => all.indexOf(k) === i && !TIERS.some(tier => tier.key === k))
        .map(k => ({ key: k, label: k }));
    return [...known, ...extra];
}

function pinnedCount(params: TierToolParams, tier: string): number {
    return Object.values(asRecord<Record<string, unknown>>(params[tier])).reduce((n, pins) => n + Object.keys(asRecord(pins)).length, 0);
}

export default function DirectChatToolsMatrix() {
    const { t } = useTranslation();
    const queryClient = useQueryClient();
    const { confirm, confirmDialog } = useConfirm();
    const query = useQuery({ queryKey: matrixKey, queryFn: ({ signal }) => readMatrix(signal), staleTime: 0, retry: false });
    const read = query.data ?? { tools: {}, params: {} };
    const restricted = Object.keys(read.tools).length > 0;

    const reset = async () => {
        const ok = await confirm({
            title: t('ai_model_setup.dc_tools_reset_title', 'Use the default tools on every tier?'),
            description: t('ai_model_setup.dc_tools_reset_desc', 'The tool lists per tier are removed: every tier calls the tools marked for direct chat again. Pinned parameters stay.'),
            confirmLabel: t('ai_model_setup.dc_tools_reset', 'Use default tools'),
            destructive: true,
        });
        if (!ok) return;
        try {
            await apiRequest('POST /ai/config/direct-chat-tools', { body: {} });
            toast.success(t('ai_model_setup.dc_tools_reset_done', 'Every tier uses the default tools again'));
            void queryClient.invalidateQueries({ queryKey: matrixKey });
        } catch (err) {
            if (!(err instanceof ApiError)) throw err;
            toast.error(t('ai_model_setup.dc_tools_reset_failed', 'The tool lists could not be reset'));
        }
    };

    return (
        <SettingsGroup
            title={t('ai_model_setup.dc_tools_title', 'Tools per tier')}
            description={restricted
                ? t('ai_model_setup.dc_tools_restricted', 'Some tiers have a list of their own: they call only the tools listed. A tier without a list calls the tools marked for direct chat.')
                : t('ai_model_setup.dc_tools_default', 'No tier has a list of its own: every tier calls the tools marked for direct chat.')}
            actions={restricted ? <Button variant="secondary" size="sm" onClick={() => { void reset(); }}>{t('ai_model_setup.dc_tools_reset', 'Use default tools')}</Button> : undefined}
        >
            <SettingsList>
                {tierRows(read).map(({ key, label }) => {
                    const ids = read.tools[key];
                    const pins = pinnedCount(read.params, key);
                    return (
                        <SettingRow
                            key={key}
                            label={label}
                            hint={pins > 0 ? t('ai_model_setup.dc_tools_pinned', '{n} pinned tool parameters', { n: pins }) : undefined}
                        >
                            <div className="flex flex-wrap justify-end gap-1">
                                {ids === undefined
                                    ? <span className={CHIP}>{t('ai_model_setup.dc_tools_default_chip', 'Default tools')}</span>
                                    : ids.length === 0
                                        ? <span className={CHIP_WARNING}>{t('ai_model_setup.dc_tools_none', 'No tools')}</span>
                                        : ids.map(id => <span key={id} className={`${CHIP} font-mono`}>{id}</span>)}
                            </div>
                        </SettingRow>
                    );
                })}
            </SettingsList>
            {confirmDialog}
        </SettingsGroup>
    );
}
