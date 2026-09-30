/**
 * A map a tool embedded (the web's MapEmbedRenderer). No WebView here: the
 * card names the place and opens it in Maps, where a phone user would take
 * a route anyway. What it opens is a Maps link, never the embed itself
 * (model/mapEmbed.ts says why); a map that names no place has no button.
 */

import React from 'react';
import { Linking } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { mapEmbedLink } from '@/features/chat/model/mapEmbed';
import type { MapEmbed } from '@/features/chat/model/types';
import { Button, useToast } from '@/shared/ui';

import { MediaCardFrame } from './MediaCardFrame';

export function MapEmbedCard({ map }: { map: MapEmbed }) {
    const t = useTranslation();
    const { toast } = useToast();
    const link = mapEmbedLink(map);
    const open = (url: string) =>
        void Linking.openURL(url).catch(() => toast(t('mobile.chat.maps_failed', 'Maps could not be opened on this phone.'), 'error'));
    return (
        <MediaCardFrame icon="MapPin" title={map.title || t('mobile.markdown.map', 'Map')}>
            {link ? (
                <Button
                    label={t('mobile.markdown.open_in_maps', 'Open in Maps')}
                    iconName="ExternalLink"
                    size="sm"
                    variant="secondary"
                    onPress={() => open(link)}
                />
            ) : null}
        </MediaCardFrame>
    );
}
