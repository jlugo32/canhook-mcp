import { vi } from 'vitest';
import type { Deps } from '../../src/contracts/index.js';
import { fakeDeps as base } from './fakes.js';

/** fakeDeps with every write method wrapped in vi.fn() so tests can assert calls. */
export const fakeDeps = (): Deps => base(((f: any) => vi.fn(f)) as any);
