import { Lock, Users } from 'lucide-react';
import React from 'react';
import type { TranslateFn } from '@/hooks/useTranslation';
import { TONES } from '@/components/shared/statusTone';

interface AccessNowCardProps {
    now: { tone: string; who: string; namedLine: string };
    app: { isPublished?: boolean; publishedVersion?: string | number } | null;
    presenter: boolean;
    t: TranslateFn;
}

export default function AccessNowCard({ now, app, presenter, t }: AccessNowCardProps) {
    // Where it stands, before anything on this screen happens.
    return (
        <section
            className={`rounded-2xl [background:var(--bg-card)] [border:1px_solid_var(--border-default)] [box-shadow:var(--shadow-md)] ${presenter ? '[padding:24px]' : '[padding:18px]'}`}
            data-testid="playbook-access-now"
            data-tone={now.tone}
        >
            <div className="flex items-start gap-3">
                <span
                    className="inline-flex items-center justify-center shrink-0 rounded-xl"
                    style={{
                        width: presenter ? 44 : 36, height: presenter ? 44 : 36,
                        background: `color-mix(in srgb, ${now.tone === 'open' ? 'var(--warning)' : 'var(--kind-playbook)'} 12%, transparent)`,
                        color: now.tone === 'open' ? TONES.warning.ink : 'var(--kind-playbook)',
                    }}
                >
                    {now.tone === 'private' ? <Lock className="w-5 h-5" aria-hidden="true" /> : <Users className="w-5 h-5" aria-hidden="true" />}
                </span>
                <div className="min-w-0 flex-1">
                    <p className={`font-semibold [color:var(--text-primary)] ${presenter ? '[font-size:18px]' : '[font-size:15px]'}`} data-testid="playbook-access-now-who">
                        {now.who}
                    </p>
                    <p className={`[color:var(--text-secondary)] ${presenter ? '[font-size:13px]' : '[font-size:11px]'}`}>{now.namedLine}</p>
                    <p className={`mt-0.5 [color:var(--text-tertiary)] ${presenter ? '[font-size:13px]' : '[font-size:11px]'}`} data-testid="playbook-access-publish-state">
                        {app && app.isPublished
                            ? t('playbooks.access.published_now', 'Published now{v}. Approving publishes a fresh copy of the app as it stands.', { v: app.publishedVersion ? ` · v${app.publishedVersion}` : '' })
                            : t('playbooks.access.private_now', 'A private draft for now. Approving with an audience publishes a copy of the app as it stands.')}
                    </p>
                </div>
            </div>
        </section>
    );
}
