/** The view tones of model/playbookView.ts as the kit's text and badge tones. */

import type { BadgeTone, TextTone } from '@/shared/ui';

import type { ViewTone } from './playbookView';

export const VIEW_TONE_TEXT: Readonly<Record<ViewTone, TextTone>> = {
    success: 'success',
    neutral: 'secondary',
    error: 'error',
    ai: 'info',
};

export const VIEW_TONE_BADGE: Readonly<Record<ViewTone, BadgeTone>> = {
    success: 'success',
    neutral: 'neutral',
    error: 'error',
    ai: 'ai',
};
