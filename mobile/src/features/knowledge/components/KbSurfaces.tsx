/**
 * "Where it can be used" — which pickers offer the base: agents, chat,
 * routines (the web's SurfaceCard trio). Switching a surface off does not
 * detach what already uses it, so a card says how many still are. The last
 * surface cannot go: a base has to be usable somewhere.
 */

import React from 'react';

import type { DeleteGuardRow } from '@/core/api/deleteGuard';
import { useTranslation, type TranslateFn } from '@/core/i18n';
import { Card, Section, ToggleRow, useToast } from '@/shared/ui';

import { attachedCount, SURFACES, surfacesOf, toggleSurface, type Surface } from '../model/settings';
import type { KnowledgeBase } from '../model/types';

function surfaceLabel(t: TranslateFn, s: Surface): string {
    if (s === 'agent') return t('knowledge.settings.surface_agent', 'Agents');
    if (s === 'direct_chat') return t('knowledge.settings.surface_direct_chat', 'Chat');
    return t('knowledge.settings.surface_ai_step', 'Routines');
}

function attachedNote(t: TranslateFn, n: number): string | undefined {
    if (n === 0) return undefined;
    return n === 1 ? t('knowledge.settings.still_attached_one', 'still attached to 1') : t('knowledge.settings.still_attached', 'still attached to {n}', { n });
}

export function KbSurfaces({ kb, usage, disabled, onChange }: {
    kb: KnowledgeBase; usage: readonly DeleteGuardRow[] | undefined; disabled: boolean; onChange: (contexts: string[]) => void;
}) {
    const t = useTranslation();
    const { toast } = useToast();
    const current = surfacesOf(kb);
    return (
        <Section title={t('knowledge.settings.where_title', 'Where it can be used')} subtitle={t('knowledge.settings.where_hint', 'This decides which pickers offer this knowledge base. It does not change who may read what is in it — that is below.')}>
            <Card padded={false}>
                {SURFACES.map((s) => (
                    <ToggleRow
                        key={s}
                        label={surfaceLabel(t, s)}
                        description={current.includes(s) ? undefined : attachedNote(t, attachedCount(usage, s))}
                        value={current.includes(s)}
                        disabled={disabled}
                        onValueChange={() => {
                            const next = toggleSurface(current, s);
                            if (next) onChange(next);
                            else toast(t('knowledge.settings.err_no_surface', 'A knowledge base has to be usable somewhere. Pick another place first.'), 'error');
                        }}
                    />
                ))}
            </Card>
        </Section>
    );
}
