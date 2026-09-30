/**
 * "Rewrite the summary" from the transcript already on the server — no audio,
 * no re-transcribing. The templates load only while this sheet is open; if
 * they cannot, the general built-in is still offered.
 */

import { useRouter } from 'expo-router';
import React from 'react';
import { View } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useThemedStyles } from '@/core/theme/ThemeProvider';
import { useSummaryTemplates, type SummaryTemplate } from '@/features/meetingTemplates';
import { Button, LoadingState, Section, Sheet } from '@/shared/ui';

import { makeMeetingStyles } from './meetingStyles';

export type RegenerateChoice = { template?: string; templateId?: string };

/** One button per template. A render helper, not a component: the rows are the sheet's. */
function templateButtons(templates: SummaryTemplate[], choose: (template: SummaryTemplate) => void) {
    return templates.map((template) => (
        <Button key={template.id} label={template.name} variant="secondary" fullWidth onPress={() => choose(template)} />
    ));
}

export function RegenerateSheet({
    visible,
    busy,
    onChoose,
    onClose,
}: {
    visible: boolean;
    busy: boolean;
    onChoose: (choice: RegenerateChoice) => void;
    onClose: () => void;
}) {
    const styles = useThemedStyles(makeMeetingStyles);
    const t = useTranslation();
    const router = useRouter();
    const templates = useSummaryTemplates(visible);
    const custom = templates.data?.custom ?? [];
    return (
        <Sheet
            visible={visible}
            onClose={onClose}
            title="Rewrite the summary"
            subtitle="Uses the transcript that is already here — no audio, no re-transcribing."
        >
            {busy ? (
                <LoadingState label="Rewriting the notes. This takes a moment on a long meeting." />
            ) : (
                <View style={styles.stackMd}>
                    {custom.length > 0 ? (
                        <Section title="Your templates">
                            <View style={styles.stackSm}>
                                {templateButtons(custom, (tpl) => onChoose({ templateId: tpl.id }))}
                            </View>
                        </Section>
                    ) : null}
                    <Section title="Built in">
                        <View style={styles.stackSm}>
                            {templateButtons(templates.data?.builtins ?? [], (tpl) => onChoose({ template: tpl.id }))}
                            {templates.isLoading ? <LoadingState /> : null}
                            {templates.isError ? (
                                <Button
                                    label="General meeting"
                                    variant="secondary"
                                    fullWidth
                                    onPress={() => onChoose({ template: 'general' })}
                                />
                            ) : null}
                        </View>
                    </Section>
                    <Button
                        label={t('mobile.recording.manage_templates', 'Manage templates')}
                        variant="ghost"
                        iconName="LayoutTemplate"
                        onPress={() => {
                            onClose();
                            router.push('/meeting-templates');
                        }}
                    />
                </View>
            )}
        </Sheet>
    );
}
