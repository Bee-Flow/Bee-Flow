import { GalleryHorizontal } from 'lucide-react';
import type { ComponentExtension } from '../../componentRegistry.types';
import AppCarousel from '../AppCarousel';

const entry: ComponentExtension = {
    Component: AppCarousel,
    icon: GalleryHorizontal,
    sample: { props: { loop: false, showDots: true } },
};

export default entry;
