/**
 * The only module in src/ that imports `zod` directly (oxlint enforces it).
 * Everything else takes `z` from here, so `jitless` is already set when the
 * first schema is built: zod decides per object schema, at construction time,
 * whether to compile a fast path with `new Function`, which the overlay and
 * panels CSP (`script-src 'self'`, no 'unsafe-eval') blocks and reports
 * (AD-24).
 */
import { z } from 'zod';

z.config({ jitless: true });

export { z };
