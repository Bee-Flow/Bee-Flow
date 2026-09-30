/**
 * Creating media from the chat (the web's media panel): a tab per kind this
 * person may use — image, video, music and speech, sound effects — each with
 * a switch per generator and the defaults the model uses when asked. The
 * settings are remembered on the phone and ride along with every turn
 * (imageGenSettings, nanoBananaSettings, disabledMedia).
 */

import React, { useState } from 'react';
import { View } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import type { MediaKind } from '@/features/chat/model/mediaCatalog';
import { MEDIA_KIND_WORDS, panelsFor, type MediaPanel } from '@/features/chat/model/mediaPanels';
import { useMediaSettings } from '@/features/chat/model/mediaSettings';
import { Segmented, Sheet, Text, ToggleRow } from '@/shared/ui';

import { MediaControlRow } from './MediaControlRow';

const makeStyles = (theme: Theme) => ({
    body: { gap: theme.spacing.lg },
});

export function MediaSheet({
    visible,
    onClose,
    gates,
}: {
    visible: boolean;
    onClose: () => void;
    gates: Readonly<Record<MediaKind, boolean>>;
}) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    const panels = panelsFor(gates);
    const [tab, setTab] = useState<MediaPanel['id']>(panels[0]?.id ?? 'image');
    const sections = useMediaSettings((s) => s.sections);
    const disabled = useMediaSettings((s) => s.disabled);
    const set = useMediaSettings((s) => s.set);
    const toggle = useMediaSettings((s) => s.toggle);
    const panel = panels.find((p) => p.id === tab) ?? panels[0];

    return (
        <Sheet visible={visible} onClose={onClose} title={t('chat.composer.tools_media', 'Create image, music, video')} tall>
            {panel ? (
                <View style={styles.body}>
                    {panels.length > 1 ? (
                        <Segmented
                            options={panels.map((p) => ({ value: p.id, label: t(p.tab.i18nKey, p.tab.en) }))}
                            value={panel.id}
                            onChange={setTab}
                            fullWidth
                        />
                    ) : null}
                    <Text variant="caption" tone="secondary">
                        {t(panel.intro.i18nKey, panel.intro.en)}
                    </Text>
                    {panel.kinds
                        .filter((kind) => gates[kind])
                        .map((kind) => (
                            <ToggleRow
                                key={kind}
                                label={t(MEDIA_KIND_WORDS[kind].i18nKey, MEDIA_KIND_WORDS[kind].en)}
                                value={!disabled[kind]}
                                onValueChange={() => toggle(kind)}
                                gutter={false}
                            />
                        ))}
                    {panel.controls.map((control) => (
                        <MediaControlRow
                            key={`${control.section}.${control.key}`}
                            control={control}
                            value={sections[control.section]?.[control.key]}
                            onChange={(next) => set(control.section, control.key, next)}
                        />
                    ))}
                </View>
            ) : null}
        </Sheet>
    );
}
