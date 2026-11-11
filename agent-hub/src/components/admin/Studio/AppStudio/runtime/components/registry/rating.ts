import { Star } from 'lucide-react';
import type { ComponentExtension } from '../../componentRegistry.types';
import AppRating from '../AppRating';

const entry: ComponentExtension = {
    Component: AppRating,
    icon: Star,
    sample: { props: { name: 'rating', label: 'Rating', max: 5 } },
};

export default entry;
