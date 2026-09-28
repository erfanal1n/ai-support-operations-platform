import { describe, expect, it } from 'vitest';
import { MemoryStore } from './db.js';

describe('MemoryStore Fixtures & Audit Trailing', () => {
  it('seeds default enterprise policies, customers, and invoices', () => {
    const store = new MemoryStore();
    expect(store.policies.size).toBeGreaterThanOrEqual(4);
    expect(store.customers.size).toBe(3);
    expect(store.invoices.size).toBe(3);
  });

  it('records tamper-evident append-only audit entries', () => {
    const store = new MemoryStore();
    const entry = store.appendAudit('SYSTEM', 'POLICY_CHECK', 'cust_acme_corp', {
      matchedRule: 'POL-REFUND-STANDARD',
    });

    expect(entry.id).toMatch(/^audit_/);
    expect(store.auditLogs.length).toBe(1);
    expect(store.auditLogs[0]?.details['matchedRule']).toBe('POL-REFUND-STANDARD');
  });
});
