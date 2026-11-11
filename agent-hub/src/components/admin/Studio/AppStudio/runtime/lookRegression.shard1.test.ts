// The web half of the App Studio compatibility gate: see src/test/appLookRegression.ts
// and server/appStudio/compat/README.md. A red test here means an app that exists today
// renders differently; read the snapshot diff before anything else.
import { defineLookShard } from '@/test/appLookRegression';

defineLookShard(0, 2);
