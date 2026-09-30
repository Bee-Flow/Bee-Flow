/**
 * The Design tab of a page (the web's workspace panel): a preset, the two
 * colours, the typeface, sizes and margins, the paper, where the logo sits
 * and whether the header and footer print. The house style, when the
 * document uses it, sits under these.
 */

import React from 'react';

import { useTranslation } from '@/core/i18n';
import { FilterPills, TextField, ToggleRow } from '@/shared/ui';

import { TabFrame } from './TabFrame';
import type { DocumentWrite } from '../hooks/useDocumentWriter';
import { useSettingsDraft } from '../hooks/useSettingsDraft';
import { applyPreset, clampNumber, DESIGN_NUMBERS, DESIGN_PRESETS, isHexColour, presetOf, setDesignValue, type DesignPreset } from '../model/design';
import { designOf, designPatch } from '../model/patches';
import type { StudioDocument } from '../model/types';

type Loose = Record<string, unknown>;

function useNumberLabels(): Record<string, string> {
    const t = useTranslation();
    return {
        fontSize: t('mobile.studio_documents.design.font_size', 'Font size'),
        lineHeight: t('mobile.studio_documents.design.line_height', 'Line spacing'),
        margin: t('mobile.studio_documents.design.margin', 'Page margins (mm)'),
        logoWidth: t('mobile.studio_documents.design.logo_width', 'Logo width (mm)'),
    };
}

function Choices({ design, set }: { design: Loose; set: (key: string, value: unknown) => void }) {
    const t = useTranslation();
    const pick = (key: string, options: string[], fallback: string, label: string) => (
        <FilterPills
            value={typeof design[key] === 'string' ? (design[key] as string) : fallback}
            onChange={(value) => set(key, value)}
            options={options.map((value) => ({ value, label: value }))}
            accessibilityLabel={label}
        />
    );
    return (
        <>
            {pick('font', ['sans', 'serif', 'mono'], 'sans', t('mobile.studio_documents.design.font', 'Font'))}
            {pick('pageSize', ['A4', 'Letter'], 'A4', t('mobile.studio_documents.design.paper', 'Paper size'))}
            {pick('logoPosition', ['left', 'center', 'right'], 'left', t('mobile.studio_documents.design.logo_position', 'Logo position'))}
            <ToggleRow label={t('mobile.studio_documents.design.header', 'Show header')} value={design.showHeader !== false} onValueChange={(v) => set('showHeader', v)} gutter={false} />
            <ToggleRow label={t('mobile.studio_documents.design.footer', 'Show footer')} value={design.showFooter !== false} onValueChange={(v) => set('showFooter', v)} gutter={false} />
        </>
    );
}

export function DesignTab({ doc, write }: { doc: StudioDocument; write: DocumentWrite }) {
    const t = useTranslation();
    const labels = useNumberLabels();
    const draft = useSettingsDraft<Loose>(designOf(doc), write, designPatch);
    const design = draft.draft;
    const set = (key: string, value: unknown) => draft.setDraft((d) => setDesignValue(d, key, value));
    const colours = ['accent', 'ink'] as const;
    const badColour = colours.some((k) => design[k] !== undefined && !isHexColour(design[k]));
    return (
        <TabFrame
            editable={doc.editable}
            save={{
                dirty: draft.dirty,
                saving: draft.saving,
                error: draft.error,
                onSave: () => void draft.save(),
                problem: badColour ? t('mobile.studio_documents.design.bad_colour', 'A colour is written as #rrggbb, like #334155.') : null,
            }}
        >
            <FilterPills<DesignPreset>
                value={presetOf(design)}
                onChange={(preset) => draft.setDraft(applyPreset(preset))}
                options={(Object.keys(DESIGN_PRESETS) as DesignPreset[]).map((value) => ({ value, label: value }))}
                accessibilityLabel={t('mobile.studio_documents.design.preset', 'Preset')}
            />
            {colours.map((key) => (
                <TextField
                    key={`${key}:${presetOf(design)}`}
                    label={key === 'accent' ? t('mobile.studio_documents.design.accent', 'Accent color') : t('mobile.studio_documents.design.ink', 'Text color')}
                    defaultValue={String(design[key] ?? DESIGN_PRESETS.neutral[key])}
                    autoCapitalize="none"
                    autoCorrect={false}
                    onChangeText={(value) => set(key, value.trim())}
                />
            ))}
            {DESIGN_NUMBERS.map((spec) => (
                <TextField
                    key={`${spec.key}:${presetOf(design)}`}
                    label={labels[spec.key] ?? spec.key}
                    hint={`${spec.min}–${spec.max}`}
                    defaultValue={String(design[spec.key] ?? spec.fallback)}
                    keyboardType="decimal-pad"
                    onChangeText={(text) => {
                        const n = clampNumber(text, spec);
                        if (n !== null) set(spec.key, n);
                    }}
                />
            ))}
            <Choices design={design} set={set} />
        </TabFrame>
    );
}
