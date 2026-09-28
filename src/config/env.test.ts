import { describe, expect, it } from 'vitest';
import { env } from './env.js';

describe('Environment Configuration', () => {
  it('loads valid default configurations', () => {
    expect(env.PORT).toBeGreaterThan(0);
    expect(env.HOST).toBe('127.0.0.1');
    expect(env.APPROVAL_REFUND_THRESHOLD_CENTS).toBe(10000);
    expect(['development', 'test', 'production']).toContain(env.NODE_ENV);
  });

  it('provides an immutable config object', () => {
    expect(Object.isFrozen(env)).toBe(true);
  });
});
