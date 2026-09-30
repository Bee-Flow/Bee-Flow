/** A row's words in the reader's language (the author's own words stay as typed). */

import type { TranslateFn } from '@/core/i18n';
import type { RowText } from '@/features/flow-editor/model/outline';

export function rowWords(text: RowText, t: TranslateFn): string {
    return 'raw' in text ? text.raw : t(text.key, text.fallback, text.params);
}
