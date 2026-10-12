import { Building2, Users } from 'lucide-react';
import React from 'react';
import { useTranslation } from '../../../../../hooks/useTranslation';
import { ChoiceCards } from '../../ui/Choice';
import { Field, Input, Textarea } from '../../ui/Input';

export function BasicsSection({ form, update }) {
    const { t } = useTranslation();
    return (
        <div className="space-y-5">
            <div>
                <h3 className="text-[15px] font-bold text-[var(--text-primary)] mb-1">{t('admin_subscriptions.basics_title', 'Basics')}</h3>
                <p className="text-[12px] text-[var(--text-muted)]">{t('admin_subscriptions.basics_desc', 'Who this plan is for and how it appears to customers.')}</p>
            </div>

            <Field label={t('admin_subscriptions.basics_type', 'Plan type')} hint={t('admin_subscriptions.basics_type_hint', 'who this plan is sold to')}>
                <ChoiceCards
                    value={form.plan_type}
                    onChange={v => update('plan_type', v)}
                    options={[
                        { value: 'organization', label: t('admin_subscriptions.basics_org', 'Organization'), description: t('admin_subscriptions.basics_org_desc', 'For teams & companies'), icon: Building2, accent: 'sky' },
                        { value: 'consumer',     label: t('admin_subscriptions.basics_consumer', 'Consumer'), description: t('admin_subscriptions.basics_consumer_desc', 'For individuals'),      icon: Users,     accent: 'emerald' },
                    ]}
                />
            </Field>

            <Field label={t('admin_subscriptions.basics_name', 'Plan name *')}>
                <Input
                    value={form.name}
                    onChange={e => update('name', e.target.value)}
                    placeholder={t('admin_subscriptions.basics_name_placeholder', 'e.g. Pro, Enterprise')}
                    autoFocus
                />
            </Field>

            <Field label={t('admin_subscriptions.basics_tagline', 'Tagline')} hint={t('admin_subscriptions.basics_tagline_hint', 'short marketing line shown in onboarding cards')}>
                <Input
                    value={form.tagline}
                    onChange={e => update('tagline', e.target.value)}
                    placeholder={t('admin_subscriptions.basics_tagline_placeholder', 'e.g. Best for Nextcloud teams')}
                />
            </Field>

            <Field label={t('admin_subscriptions.basics_description', 'Description')}>
                <Textarea
                    value={form.description}
                    onChange={e => update('description', e.target.value)}
                    placeholder={t('admin_subscriptions.basics_description_placeholder', 'Brief description of this plan')}
                    rows={2}
                />
            </Field>
        </div>
    );
}
