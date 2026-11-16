import { AlertTriangle, DatabaseZap, Timer, Trash2 } from 'lucide-react';
import type { TranslateFn } from '@/hooks/useTranslation';
import { nOf } from '@/utils/plural';
import Button from '@/components/shared/Button';
import Section from '@/components/shared/Section';
import { SettingBlock, SettingsGroup, SettingsList } from '@/components/shared/SettingsList';
import Slider from '@/components/shared/Slider';
import Toggle from '@/components/shared/Toggle';
import { ALERT_WARNING } from '@/components/shared/adminUi';

// The pieces of OrgIntegrationCacheEditor: the two ChoiceCards, what may be kept
// and the reuse window, what is stored now with its clear button.

const MINUTES = (s: number) => Math.round(s / 60);

// An admin deciding whether to clear needs a size, not just a count — a
// thousand calendar look-ups and a thousand mail searches are not the same
// amount of somebody's data sitting in the database.
const BYTES = (n: number) => {
    if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
    if (n >= 1024) return `${Math.round(n / 1024)} kB`;
    return `${n} B`;
};

/** Off (ask every run) or on (keep answers for a while), as ChoiceCards options. */
export function cacheModeOptions(t: TranslateFn) {
    return [
        {
            value: 'off',
            label: t('admin.integration_cache.off', 'Ask every run (recommended)'),
            description: t(
                'admin.integration_cache.off_desc',
                'Nothing an app answers is stored. An automation can still avoid asking the same thing twice inside one run — that reuse never leaves the run.',
            ),
            Icon: DatabaseZap,
        },
        {
            value: 'on',
            label: t('admin.integration_cache.on', 'Keep answers for a short while'),
            description: t(
                'admin.integration_cache.on_desc',
                'Answers to look-ups are stored, encrypted, so a later run can use them instead of asking again. Only look-ups, never anything that changes something, and only for steps whose author asked for it. Faster and cheaper — but a run can then work from data that is a few minutes old.',
            ),
            Icon: Timer,
        },
    ];
}

/** The operator has switched the store off for the whole server. */
export function KillSwitchNotice({ t }: { t: TranslateFn }) {
    return (
        <div role="status" className={ALERT_WARNING}>
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
            <span className="text-sm">
                {t(
                    'admin.integration_cache.kill_switch',
                    'This is switched off for the whole server by its operator, so nothing is stored whatever you choose here.',
                )}
            </span>
        </div>
    );
}

export interface CacheScopes {
    integration: boolean;
    http: boolean;
    ai: boolean;
}

interface ScopeRowsProps {
    t: TranslateFn;
    saving: boolean;
    scopes: CacheScopes;
    setScope: (patch: Partial<CacheScopes>) => void;
}

/** What may be kept: connected-app answers, web-service replies, AI-step answers. */
function ScopeRows({ t, saving, scopes, setScope }: ScopeRowsProps) {
    return (
        <>
            <Toggle
                flat
                checked={scopes.integration}
                disabled={saving}
                onChange={(on) => setScope({ integration: on })}
                label={t('admin.integration_cache.scope_integration', 'Answers from connected apps')}
                description={t('admin.integration_cache.scope_integration_desc', 'Look-ups an automation makes through an app action — a calendar, a mailbox, a ticket system.')}
            />
            <Toggle
                flat
                checked={scopes.http}
                disabled={saving}
                onChange={(on) => setScope({ http: on })}
                label={t('admin.integration_cache.scope_http', 'Answers from web service calls')}
                description={t('admin.integration_cache.scope_http_desc', 'Replies to a "Call a web service" step, which can point at any address the automation author chooses. Only ever GET and HEAD, and never when that step is allowed to reach private addresses.')}
            />
            <Toggle
                flat
                checked={scopes.ai}
                disabled={saving}
                onChange={(on) => setScope({ ai: on })}
                label={t('admin.integration_cache.scope_ai', 'Answers from AI steps')}
                description={t('admin.integration_cache.scope_ai_desc', 'When an AI step asks the same question with the same (privacy-protected) input, the stored answer is reused instead of asking the model again. Stored encrypted until the window ends; never used in test runs.')}
            />
        </>
    );
}

interface KeptSettingsProps extends ScopeRowsProps {
    range: { min: number; max: number };
    ttlSeconds: number;
    setTtlSeconds: (seconds: number) => void;
}

/** What may be kept, and how long an answer may be reused (whole minutes on the slider). */
export function KeptSettings({ t, saving, scopes, setScope, range, ttlSeconds, setTtlSeconds }: KeptSettingsProps) {
    return (
        <SettingsGroup
            title={t('admin.integration_cache.scopes_label', 'What may be kept')}
            description={t(
                'admin.integration_cache.scopes_note',
                'These are different promises. The first is about apps this organisation connected and whose permissions it manages. The second is about any web address an automation author types in, and the third about what an AI model wrote, so those two are off until you say otherwise.',
            )}
        >
            <SettingsList>
                <ScopeRows t={t} saving={saving} scopes={scopes} setScope={setScope} />
                <SettingBlock
                    label={t('admin.integration_cache.ttl_label', 'How long an answer may be reused')}
                    htmlFor="integration-cache-ttl"
                    hint={t(
                        'admin.integration_cache.ttl_note',
                        'After this, the answer is deleted and the next run asks the app again. This is also the longest a run can be working from stale data. Shortening it applies to answers already stored, not just new ones.',
                    )}
                >
                    <Slider
                        id="integration-cache-ttl"
                        min={range.min}
                        max={range.max}
                        step={60}
                        value={ttlSeconds}
                        onChange={setTtlSeconds}
                        disabled={saving}
                        valueFormatter={(s) => nOf(t, 'admin_org_ai.cache_minutes', MINUTES(s), '1 minute', '{count} minutes')}
                    />
                </SettingBlock>
            </SettingsList>
        </SettingsGroup>
    );
}

interface StoredAnswersProps {
    t: TranslateFn;
    storedEntries: number;
    storedBytes: number;
    expiredEntries: number;
    clearing: boolean;
    onClear: () => void;
}

/** What is stored right now, how much of it has already expired, and the button that deletes it all. */
export function StoredAnswers({ t, storedEntries, storedBytes, expiredEntries, clearing, onClear }: StoredAnswersProps) {
    const size = BYTES(storedBytes);
    return (
        <Section>
            <p className="m-0 text-sm text-[var(--text-secondary)]" data-testid="integration-cache-stored">
                {nOf(t, 'admin_org_ai.cache_held', storedEntries, 'Stored right now: 1 answer, {size}.', 'Stored right now: {count} answers, {size}.', { size })}
                {expiredEntries > 0 && ` ${nOf(
                    t,
                    'admin_org_ai.cache_held_expired',
                    expiredEntries,
                    '1 of those has already expired and is never served. The hourly clean-up deletes it, or the button below does.',
                    '{count} of those have already expired and are never served. The hourly clean-up deletes them, or the button below does.',
                )}`}
            </p>
            <Button variant="secondary" icon={Trash2} onClick={onClear} busy={clearing} className="mt-3">
                {nOf(t, 'admin_org_ai.cache_clear', storedEntries, 'Delete the stored answer now', 'Delete the {count} stored answers now')}
            </Button>
        </Section>
    );
}
