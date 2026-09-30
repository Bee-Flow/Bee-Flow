/**
 * Settings: the page's name and description, the brief the builder reads on
 * every turn, and the knowledge bases it searches — everything PUT /:id
 * accepts from a person. The card details (glyph, accent colour, tagline)
 * and the framework are the builder's to set (the server's update schema
 * refuses them), so they are shown here, not edited.
 */

import React, { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { describeError } from '@/core/api/errors';
import { useTranslation } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { maxLength, useForm } from '@/shared/patterns';
import { Banner, Button, Card, InfoRow, Section, TextField, useToast } from '@/shared/ui';

import { DangerZone } from './DangerZone';
import { KbPickerSheet } from './KbPickerSheet';
import { TabScroll } from './TabScroll';
import { useUpdateWebpage } from '../hooks/mutations';
import { useWebpage } from '../hooks/queries';
import { attachedKnowledgeBaseIds, ownKnowledgeBaseId } from '../model/knowledgeBases';
import type { Webpage } from '../model/types';

const makeStyles = (theme: Theme) => StyleSheet.create({ body: { gap: theme.spacing.md } });

type DetailsForm = { name: string; description: string; instructions: string };

function DetailsSection({ webpage }: { webpage: Webpage }) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    const { toast } = useToast();
    const update = useUpdateWebpage(webpage.id);
    const initial: DetailsForm = {
        name: webpage.name,
        description: webpage.description,
        instructions: webpage.instructions,
    };
    const form = useForm({
        initial,
        validate: { name: [maxLength(200, t('mobile.webpages.settings.name_long', 'At most 200 characters.'))] },
        onSubmit: (values) => update.mutateAsync(values),
    });
    const save = async () => {
        if (!(await form.submit())) return;
        form.reset(form.values);
        toast(t('common.saved', 'Saved'), 'success');
    };

    return (
        <Section title={t('mobile.webpages.settings.details', 'Details')}>
            <Card>
                <View style={styles.body}>
                    <TextField label={t('common.name', 'Name')} {...form.field('name')} />
                    <TextField
                        label={t('common.description', 'Description')}
                        multiline
                        {...form.field('description')}
                    />
                    <TextField
                        label={t('mobile.webpages.settings.instructions', 'Instructions for the builder')}
                        hint={t(
                            'mobile.webpages.settings.instructions_hint',
                            'Read on every turn: tone, brand rules, what to keep.',
                        )}
                        multiline
                        maxLines={10}
                        {...form.field('instructions')}
                    />
                    <Button
                        label={t('common.save', 'Save')}
                        disabled={!form.dirty || !form.canSubmit}
                        loading={form.submitting}
                        onPress={() => void save()}
                    />
                    {form.submitError ? <Banner tone="error">{describeError(form.submitError).message}</Banner> : null}
                </View>
            </Card>
        </Section>
    );
}

function KnowledgeSection({ webpage }: { webpage: Webpage }) {
    const t = useTranslation();
    const [picking, setPicking] = useState(false);
    const own = ownKnowledgeBaseId(webpage);
    const attached = attachedKnowledgeBaseIds(webpage).length;
    return (
        <Section
            title={t('mobile.webpages.settings.bases', 'Knowledge bases')}
            subtitle={t('mobile.webpages.settings.bases_hint', 'The builder searches these on every turn')}
            action={
                <Button
                    label={t('mobile.webpages.settings.choose', 'Choose')}
                    variant="ghost"
                    size="sm"
                    onPress={() => setPicking(true)}
                />
            }
        >
            <Card>
                {own ? (
                    <InfoRow
                        label={t('mobile.webpages.settings.own_base', 'This page’s knowledge')}
                        value={t('mobile.webpages.settings.own_base_value', 'From the Knowledge tab')}
                    />
                ) : null}
                <InfoRow label={t('mobile.webpages.settings.attached', 'Added bases')} value={String(attached)} />
            </Card>
            <KbPickerSheet webpage={webpage} visible={picking} onClose={() => setPicking(false)} />
        </Section>
    );
}

function AboutSection({ webpage }: { webpage: Webpage }) {
    const t = useTranslation();
    const dash = '—';
    return (
        <Section
            title={t('mobile.webpages.settings.about', 'Set by the builder')}
            subtitle={t('mobile.webpages.settings.about_hint', 'Ask the builder in Build to change these')}
        >
            <Card>
                <InfoRow label={t('mobile.webpages.settings.tagline', 'Tagline')} value={webpage.tagline || dash} />
                <InfoRow label={t('mobile.webpages.settings.icon', 'Icon')} value={webpage.icon || dash} />
                <InfoRow
                    label={t('mobile.webpages.settings.accent', 'Accent colour')}
                    value={webpage.accentColor || dash}
                />
                <InfoRow
                    label={t('mobile.webpages.settings.framework', 'Built with')}
                    value={
                        webpage.framework === 'react-mui'
                            ? t('mobile.webpages.settings.react', 'React + Material UI')
                            : t('mobile.webpages.settings.vanilla', 'HTML, CSS and JavaScript')
                    }
                />
            </Card>
        </Section>
    );
}

export function SettingsTab({ pageId, webpage, onDelete }: { pageId: string; webpage: Webpage; onDelete: () => void }) {
    const page = useWebpage(pageId);
    return (
        <TabScroll onRefresh={() => page.refetch()}>
            <DetailsSection webpage={webpage} />
            <KnowledgeSection webpage={webpage} />
            <AboutSection webpage={webpage} />
            <DangerZone onDelete={onDelete} />
        </TabScroll>
    );
}
