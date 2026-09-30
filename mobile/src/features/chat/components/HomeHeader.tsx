/**
 * The Chat tab's header: the drawer toggle, the tab's name, and the global
 * search and bell.
 *
 * There used to be a Chat | Cowork pill in the middle (the web's
 * CoworkModeSwitch). Cowork now lives in Studio, next to the other things
 * that run without you, so this header no longer carries a second door to it.
 */

import React from 'react';

import { useTranslation } from '@/core/i18n';
import { ScreenHeader } from '@/shared/ui';

export function HomeHeader() {
    const t = useTranslation();
    return <ScreenHeader size="large" title={t('sidebar.direct_chat', 'Chat')} />;
}
