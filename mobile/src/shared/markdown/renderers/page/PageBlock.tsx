/**
 * A ```json-page definition, natively: the web's PageRenderer — layout,
 * content, interaction and data elements (pageElements.tsx, pageData.tsx)
 * in the report card. A button opens the web's overlay as a bottom sheet:
 * its title, its description (or "Action: …") and "Open Link →" when it
 * carries a URL, which opens as every outside link from an answer does.
 */

import React, { useState } from 'react';

import { useThemedStyles } from '@/core/theme/ThemeProvider';
import { useMarkdownEnv } from '@/shared/markdown/env';
import { Button, Sheet, Text } from '@/shared/ui';

import { renderElement, type PageCtx } from './pageElements';
import type { ButtonOverlay, PageElement } from './pageModel';
import { pageSheet } from './pageStyles';
import { RichFrame } from '../rich/RichFrame';

export { readPage } from './pageModel';

export function PageBlock({ page }: { page: PageElement }) {
    const styles = useThemedStyles(pageSheet);
    const { theme, t, open } = useMarkdownEnv();
    const [overlay, setOverlay] = useState<ButtonOverlay | null>(null);
    const ctx: PageCtx = { styles, theme, t, onButton: setOverlay };
    const close = () => setOverlay(null);

    return (
        <RichFrame>
            {renderElement(page, ctx, 'page')}
            <Sheet
                visible={overlay !== null}
                onClose={close}
                title={overlay?.title || t('run_status.info', 'Info')}
                footer={
                    overlay?.url ? (
                        <Button
                            label={t('mobile.markdown.page_open_link', 'Open Link →')}
                            onPress={() => {
                                const url = overlay.url;
                                close();
                                open(url);
                            }}
                        />
                    ) : undefined
                }
            >
                <Text variant="body" tone="secondary">
                    {overlay?.content ||
                        t('mobile.markdown.page_action', 'Action: {action}', { action: overlay?.action || 'click' })}
                </Text>
            </Sheet>
        </RichFrame>
    );
}
