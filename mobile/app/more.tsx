/**
 * The old More tab's address. The drawer took its place; its complete map is
 * /sitemap, so a link or a habit that still says /more lands there.
 */

import { Redirect } from 'expo-router';
import React from 'react';

export default function MoreRedirect() {
    return <Redirect href="/sitemap" />;
}
