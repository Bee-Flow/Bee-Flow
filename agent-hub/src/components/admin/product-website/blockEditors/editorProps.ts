import type { CmsPageOption } from '../fields';
import type { BlockData } from './shared';

// Props every block editor receives from the inspector. `D` is the shape of
// the block's content blob that the editor reads; writes go through
// `onChange` as a whole new blob.

export interface BlockEditorProps<D = BlockData> {
    data?: D;
    onChange: (next: BlockData) => void;
}

/** Editors with link pickers also get the site's page list. */
export interface BlockEditorWithPagesProps<D = BlockData> extends BlockEditorProps<D> {
    pages?: CmsPageOption[];
}
