// Moved to components/shared/RangeControl.tsx (it serves the website
// analytics and the Privacy Shield activity tab too). This path stays as a
// re-export for its old importers; new code imports the shared one.
export { default, defaultRange } from '@/components/shared/RangeControl';
export type { UsageRange } from '@/components/shared/RangeControl';
