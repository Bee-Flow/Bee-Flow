import { Tag, Plus, Percent, Euro, Hash, Clock, ToggleLeft, ToggleRight } from 'lucide-react';
import React, { useState } from 'react';
import { PromoEditor } from './PromoEditor';
import { useTranslation } from '../../../../hooks/useTranslation';
import { Button } from '../../../shared/Button';
import EmptyState from '../../../shared/EmptyState';
import { toast } from '../../../shared/Toast';
import { useResource, apiJson } from '../hooks/useApi';
import { Badge } from '../ui/Badge';
import { Card } from '../ui/Card';
import { SectionHeader } from '../ui/SectionHeader';
import { Spinner } from '../ui/Spinner';

export function PromosView() {
    const { t } = useTranslation();
    const { data: codes = [], loading, reload } = useResource('/api/stripe/promo-codes', { initial: [] });
    const [creating, setCreating] = useState(false);

    const toggle = async (code) => {
        const action = code.active ? 'deactivate' : 'activate';
        try {
            await apiJson(`/api/stripe/promo-codes/${code.id}/${action}`, { method: 'PUT' });
            toast.success(code.active
                ? t('admin_subscriptions.promos_deactivated', '{code} deactivated.', { code: code.code })
                : t('admin_subscriptions.promos_activated', '{code} activated.', { code: code.code }));
            reload();
        } catch (e) {
            toast.error(e.message || (code.active ? t('admin_subscriptions.promos_deactivate_failed', 'deactivate failed') : t('admin_subscriptions.promos_activate_failed', 'activate failed')));
        }
    };

    if (creating) {
        return <PromoEditor onBack={() => setCreating(false)} onCreated={() => { setCreating(false); reload(); }} />;
    }

    return (
        <div className="px-6 py-6 max-w-[1100px] mx-auto">
            <SectionHeader
                title={t('admin_subscriptions.promos_title', 'Promotion Codes')}
                description={t('admin_subscriptions.promos_desc', 'Create and manage discount codes that customers can apply at Stripe checkout.')}
                action={<Button icon={Plus} onClick={() => setCreating(true)}>{t('admin_subscriptions.promos_new_code', 'New code')}</Button>}
            />

            {loading ? (
                <Spinner label={t('admin_subscriptions.promos_loading', 'Loading promo codes…')} />
            ) : codes.length === 0 ? (
                <EmptyState
                    icon={<Tag className="w-6 h-6" />}
                    title={t('admin_subscriptions.promos_empty', 'No promotion codes yet')}
                    description={t('admin_subscriptions.promos_empty_desc', 'Create your first one to start running discount campaigns.')}
                    action={<Button icon={Plus} onClick={() => setCreating(true)}>{t('admin_subscriptions.promos_create', 'Create code')}</Button>}
                />
            ) : (
                <div className="flex flex-col gap-2">
                    {codes.map(c => (
                        <Card key={c.id} className={`!p-4 flex items-center justify-between gap-4 ${c.active ? '' : 'opacity-60'}`} hover>
                            <div className="flex items-center gap-4 min-w-0 flex-1">
                                <div className={`px-3 py-2 rounded-lg font-mono font-bold text-[14px] tracking-wider whitespace-nowrap ${
                                    c.active ? 'bg-emerald-500/10 text-emerald-400' : 'bg-[var(--bg-tertiary)] text-[var(--text-muted)]'
                                }`}>
                                    {c.code}
                                </div>
                                <div className="min-w-0">
                                    <div className="flex items-center gap-1.5 text-[13.5px] font-semibold text-[var(--text-primary)]">
                                        {c.discountType === 'percent' ? (
                                            <><Percent className="w-3.5 h-3.5 text-blue-400" /> {t('admin_subscriptions.promos_percent_off', '{value}% off', { value: c.discountValue })}</>
                                        ) : (
                                            <><Euro className="w-3.5 h-3.5 text-blue-400" /> {t('admin_subscriptions.promos_amount_off', '{amount} {currency} off', { amount: (c.discountValue / 100).toFixed(2), currency: c.currency?.toUpperCase() })}</>
                                        )}
                                        <span className="font-normal text-[11px] text-[var(--text-muted)]">
                                            · {c.duration === 'once' ? t('admin_subscriptions.promos_one_time', 'one-time') : c.duration === 'forever' ? t('admin_subscriptions.promos_forever_lc', 'forever') : t('admin_subscriptions.promos_months_short', '{n}mo', { n: c.durationMonths })}
                                        </span>
                                    </div>
                                    {c.name && <div className="text-[11px] text-[var(--text-muted)] mt-0.5">{c.name}</div>}
                                    <div className="flex items-center flex-wrap gap-3 mt-1 text-[11px] text-[var(--text-muted)]">
                                        <span className="inline-flex items-center gap-1">
                                            <Hash className="w-3 h-3" /> {c.maxRedemptions
                                                ? t('admin_subscriptions.promos_used_of', '{count}/{max} used', { count: c.timesRedeemed || 0, max: c.maxRedemptions })
                                                : t('admin_subscriptions.promos_used', '{count} used', { count: c.timesRedeemed || 0 })}
                                        </span>
                                        {c.expiresAt && (
                                            <span className="inline-flex items-center gap-1">
                                                <Clock className="w-3 h-3" /> {t('admin_subscriptions.promos_expires', 'expires {date}', { date: new Date(c.expiresAt).toLocaleDateString() })}
                                            </span>
                                        )}
                                        {c.firstTimeOnly && <span className="text-amber-400">{t('admin_subscriptions.promos_new_only', 'new customers only')}</span>}
                                    </div>
                                </div>
                            </div>
                            <div className="flex items-center gap-2 shrink-0">
                                <Badge tone={c.active ? 'success' : 'danger'} size="sm">
                                    {c.active ? t('admin_subscriptions.promos_active', 'Active') : t('admin_subscriptions.promos_inactive', 'Inactive')}
                                </Badge>
                                <Button
                                    size="sm"
                                    variant={c.active ? 'danger' : 'success'}
                                    icon={c.active ? ToggleRight : ToggleLeft}
                                    onClick={() => toggle(c)}
                                >
                                    {c.active ? t('admin_subscriptions.promos_deactivate', 'Deactivate') : t('admin_subscriptions.promos_activate', 'Activate')}
                                </Button>
                            </div>
                        </Card>
                    ))}
                </div>
            )}
        </div>
    );
}
