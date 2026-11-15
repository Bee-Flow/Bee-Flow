/**
 * Organisation AI context settings — one switch: conversation compaction.
 *
 * Compaction folds older turns of a long chat into a short summary and
 * truncates long tool results. That used to run for everyone, unconditionally,
 * from a fixed message count onward — which is what people report as "it
 * forgot what we were talking about". Modern models carry up to a million
 * tokens of context, so on a normal conversation there is nothing to gain from it.
 *
 * Hence: OFF by default, and the copy here is explicit that turning it on
 * trades recall for cost. The server keeps the conversation inside the model's
 * context window either way (server/core/llm/contextPolicy.js), and names the
 * model that writes the summaries (`runsOn`, the Fast tier the server
 * administrator set), so the admin knows which model reads the conversation.
 *
 * The page title is the dashboard frame's (AdminPage); this panel opens with
 * its own sub-heading so it also reads on the phone page that stacks it.
 */
import { FoldVertical, ScrollText } from 'lucide-react';
import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { useOrgSettingRead } from './useOrgSettingRead';
import OrgEditorLoad from './OrgEditorLoad';

import { useTranslation, type TranslateFn } from '@/hooks/useTranslation';
import { messageOf } from '@/utils/caughtError';
import ChoiceCards from '@/components/shared/ChoiceCards';
import SaveFooter from '@/components/shared/SaveFooter';
import { SettingBlock, SettingsGroup, SettingsList } from '@/components/shared/SettingsList';
import Slider from '@/components/shared/Slider';
import { toast } from '@/components/shared/Toast';
import { errorBody, RefusedError } from '@/api/mutate';
import { apiRequest } from '@/api/typedRequest';

// "750,000" reads better than "750000" and than "0.75M" at these magnitudes.
const formatTokens = (n: number) => Math.round(n).toLocaleString();

/** The message count the server summarises from when it sends none (contextPolicy.js). */
const DEFAULT_THRESHOLD = 16;

/** GET /api/org-ai-context/:orgId (the fields this editor reads). */
interface AiContextSettings {
    compactionEnabled?: boolean;
    compactionThreshold?: number;
    recentWindow?: number;
    contextBudgetPercent?: number;
    contextBudgetRange?: { min: number; max: number };
    contextWindowExamples?: ContextWindowExample[];
    /** The display name of the model that writes the summaries; null or absent: not known. */
    runsOn?: string | null;
}

/**
 * One worked example: the organisation's largest or smallest model
 * (server/core/llm/contextWindowExamples.mts). `label` is the server's English;
 * `kind`, `tierKey` and `model` let the line be translated here.
 */
interface ContextWindowExample {
    label: string;
    contextWindow: number;
    kind?: 'tier' | 'custom' | 'generic';
    tierKey?: string | null;
    model?: string | null;
}

/**
 * "Fast (model name)" in the viewer's language; a custom tier keeps the admin's
 * own label, and a tier name the catalogue does not have keeps the server's
 * English line.
 */
function exampleLabel(ex: ContextWindowExample, t: TranslateFn): string {
    const tier = ex.kind === 'tier' && ex.tierKey ? t(`tier.${ex.tierKey}`, '') : '';
    if (tier && ex.model) {
        return t('admin_ai_context.example_tier', '{tier} ({model})', { tier, model: ex.model });
    }
    if (ex.kind === 'generic') {
        return t('admin_ai_context.example_generic', 'A {size}-token model', { size: formatTokens(ex.contextWindow) });
    }
    return ex.label;
}

const SAVE_FAILED = 'Could not save the long-conversation context settings';

/** The loaded settings, the selection seeded from them, and the save. */
function useAiContextForm(orgId: string | null | undefined, t: TranslateFn) {
    const [enabled, setEnabled] = useState(false); // current selection
    const [budgetPercent, setBudgetPercent] = useState(75);
    const [savedAt, setSavedAt] = useState<Date | null>(null);

    const { server, loading, loadError, refetch } = useOrgSettingRead<AiContextSettings>('GET /api/org-ai-context/{orgId}', orgId);
    const [seeded, setSeeded] = useState<AiContextSettings | null>(null);
    if (server && server !== seeded) {
        setSeeded(server);
        setEnabled(!!server.compactionEnabled);
        setBudgetPercent(server.contextBudgetPercent ?? 75);
    }

    const isDirty = !!server && (
        enabled !== !!server.compactionEnabled
        || budgetPercent !== server.contextBudgetPercent
    );

    const save = useMutation({
        mutationFn: async (settings: AiContextSettings) => {
            try {
                await apiRequest('PUT /api/org-ai-context/{orgId}', {
                    params: { orgId: String(orgId) },
                    body: {
                        compactionEnabled: enabled,
                        compactionThreshold: settings.compactionThreshold,
                        recentWindow: settings.recentWindow,
                        contextBudgetPercent: budgetPercent,
                    },
                });
            } catch (err) {
                if (!(err instanceof RefusedError)) throw err;
                const body = errorBody(err) ?? {};
                throw new Error(body.error || t('admin.ai_context.save_failed', SAVE_FAILED), { cause: err });
            }
        },
        onSuccess: async () => {
            setSavedAt(new Date());
            await refetch();
        },
        onError: (err) => toast.error(messageOf(err, t('admin.ai_context.save_failed', SAVE_FAILED))),
    });
    const handleSave = () => {
        if (!server || !isDirty) return;
        save.mutate(server);
    };
    const reset = () => {
        if (!server) return;
        setEnabled(!!server.compactionEnabled);
        setBudgetPercent(server.contextBudgetPercent ?? 75);
    };

    return {
        enabled, setEnabled, budgetPercent, setBudgetPercent, server, loading, loadError, refetch,
        isDirty, saving: save.isPending, failed: save.isError, savedAt, handleSave, reset,
    };
}

type AiContextForm = ReturnType<typeof useAiContextForm>;

function ContextChoice({ form, server, t }: { form: AiContextForm; server: AiContextSettings; t: TranslateFn }) {
    const options = [
        {
            value: 'off',
            label: t('admin.ai_context.off', 'Keep the full conversation (recommended)'),
            description: t(
                'admin.ai_context.off_desc',
                'The assistant sees every earlier message, tool result and attachment for as long as they fit in the model context window. Best answers; higher token use on very long chats.',
            ),
            Icon: ScrollText,
        },
        {
            value: 'on',
            label: t('admin.ai_context.on', 'Summarise older messages'),
            description: t(
                'admin_org_ai.context_on_desc',
                'Once a chat passes about {count} messages, everything older is replaced by a short summary and long tool results are shortened. Cheaper, but detail from earlier in the conversation is permanently lost to the assistant.',
                { count: server.compactionThreshold ?? DEFAULT_THRESHOLD },
            ),
            Icon: FoldVertical,
        },
    ];
    return (
        <SettingsGroup
            title={t('admin.ai_context.title', 'Context in long conversations')}
            description={t(
                'admin.ai_context.intro',
                'How much of a long conversation the assistant keeps in view. This is not the assistant remembering things about people; that is the Memory setting. Applies to chats and agents across the whole organisation and takes effect on the next message.',
            )}
        >
            <ChoiceCards
                value={form.enabled ? 'on' : 'off'}
                onChange={(v: string) => form.setEnabled(v === 'on')}
                options={options}
                columns={1}
                ariaLabel={t('admin.ai_context.choose', 'Context in long conversations')}
                disabled={form.saving}
            />
            {server.runsOn && (
                <p className="m-0 text-xs text-[var(--text-secondary)]" data-testid="ai-context-runs-on">
                    {t('admin_org_ai.context_runs_on', 'Summaries are written by {model}, which the server administrator chooses.', { model: server.runsOn })}
                </p>
            )}
        </SettingsGroup>
    );
}

/** The safety limit applies in BOTH modes, so it sits outside the choice above. */
function SafetyLimit({ form, server, t }: { form: AiContextForm; server: AiContextSettings; t: TranslateFn }) {
    // The server owns the context-window table and the allowed range; the SPA
    // only multiplies. Falling back keeps the screen usable against an older
    // API that doesn't send these yet.
    const examples = Array.isArray(server.contextWindowExamples) ? server.contextWindowExamples : [];
    const range = server.contextBudgetRange || { min: 25, max: 95 };
    return (
        <SettingsList>
            <SettingBlock
                label={t('admin.ai_context.budget_label', 'Safety limit')}
                htmlFor="ai-context-budget"
                hint={t(
                    'admin.ai_context.safety_note',
                    'A conversation can never overflow the model: once it reaches this share of the context window, the oldest part is summarised automatically.',
                )}
            >
                <Slider
                    id="ai-context-budget"
                    min={range.min}
                    max={range.max}
                    step={5}
                    value={form.budgetPercent}
                    onChange={form.setBudgetPercent}
                    suffix="%"
                    disabled={form.saving}
                />
                {examples.length > 0 && (
                    <p className="m-0 text-xs text-[var(--text-muted)]">
                        {examples.map(ex => t('admin_ai_context.example_line', '{label}: about {tokens} tokens', {
                            label: exampleLabel(ex, t),
                            tokens: formatTokens(ex.contextWindow * form.budgetPercent / 100),
                        })).join('   ·   ')}
                    </p>
                )}
            </SettingBlock>
        </SettingsList>
    );
}

export default function OrgAiContextEditor({ orgId }: { orgId?: string | null }) {
    const { t } = useTranslation();
    const form = useAiContextForm(orgId, t);

    if (!orgId) return null;

    const { server } = form;
    const loadError = form.loadError
        ? `${t('admin.ai_context.load_failed', 'Could not load the long-conversation context settings.')} ${form.loadError}`
        : null;

    return (
        <div className="space-y-6" data-testid="org-ai-context">
            <OrgEditorLoad loading={form.loading && !server} error={loadError} onRetry={() => { void form.refetch(); }}>
                {server && (
                    <>
                        <ContextChoice form={form} server={server} t={t} />
                        <SafetyLimit form={form} server={server} t={t} />
                        <SaveFooter
                            onSave={form.handleSave}
                            onCancel={form.isDirty ? form.reset : undefined}
                            saving={form.saving}
                            dirty={form.isDirty}
                            saveState={form.saving ? 'saving' : form.failed ? 'error' : 'idle'}
                            lastSavedAt={form.savedAt}
                            onRetry={form.handleSave}
                        />
                    </>
                )}
            </OrgEditorLoad>
        </div>
    );
}
