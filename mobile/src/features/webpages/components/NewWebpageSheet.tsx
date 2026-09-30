/**
 * A new page: a name, a description of what it should be, or both — the
 * web's build bar and its "New webpage name…" field in one sheet. A
 * description becomes the builder's first message, sent as the page opens on
 * its Preview, as it is on the web; a name alone makes an empty page to
 * describe later.
 *
 * No framework is sent, as the web sends none: the server's default applies
 * (React + Material UI), and the phone previews either kind, because the
 * server builds the preview document (model/preview.ts).
 */

import { useRouter } from 'expo-router';
import React, { useRef } from 'react';

import { useTranslation } from '@/core/i18n';
import { FormSheet, useForm } from '@/shared/patterns';
import { TextField } from '@/shared/ui';

import { useCreateWebpage } from '../hooks/mutations';
import { parkBrief } from '../model/pendingBrief';
import type { Webpage } from '../model/types';

type NewPageForm = { name: string; prompt: string };

const EMPTY: NewPageForm = { name: '', prompt: '' };

export function NewWebpageSheet({ visible, onClose }: { visible: boolean; onClose: () => void }) {
    const t = useTranslation();
    const router = useRouter();
    const create = useCreateWebpage();
    const created = useRef<Webpage | null>(null);
    const form = useForm({
        initial: EMPTY,
        onSubmit: async ({ name, prompt }) => {
            created.current = await create.mutateAsync({ name, prompt });
        },
    });
    const { name, prompt } = form.values;

    const submit = async () => {
        if (!(await form.submit())) return;
        const page = created.current;
        form.reset(EMPTY);
        onClose();
        if (!page) return;
        parkBrief(page.id, prompt);
        router.push(`/webpages/${encodeURIComponent(page.id)}`);
    };

    return (
        <FormSheet
            visible={visible}
            onClose={onClose}
            title={t('mobile.webpages.new.title', 'New webpage')}
            subtitle={t('mobile.webpages.new.subtitle', 'Describe the page you want, or just give it a name')}
            submitLabel={t('common.create', 'Create')}
            onSubmit={() => void submit()}
            canSubmit={form.canSubmit && Boolean(name.trim() || prompt.trim())}
            submitting={form.submitting}
            error={form.submitError}
        >
            <TextField
                label={t('common.name', 'Name')}
                placeholder={t('mobile.webpages.new.name_placeholder', 'New webpage name…')}
                {...form.field('name')}
                maxLength={200}
            />
            <TextField
                label={t('mobile.webpages.new.prompt', 'What should it be?')}
                placeholder={t(
                    'mobile.webpages.new.prompt_placeholder',
                    'Landing page for a bakery — hero, menu grid, contact form.',
                )}
                hint={t(
                    'mobile.webpages.new.prompt_hint',
                    'Sent to the builder as its first message. Leave it empty to start from a blank page.',
                )}
                {...form.field('prompt')}
                multiline
                maxLines={6}
            />
        </FormSheet>
    );
}
