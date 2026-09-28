import type { PolicySearchCase } from './policy-search.js';

export const policySearchCases: PolicySearchCase[] = [
  {
    id: 'charged-twice',
    query: 'Why was my subscription charged twice?',
    expectedPolicyId: 'POL-REFUND-STANDARD',
  },
  {
    id: 'two-charges',
    query: 'I see two charges for this month.',
    expectedPolicyId: 'POL-REFUND-STANDARD',
  },
  {
    id: 'platform-outage',
    query: 'The platform outage lasted three hours.',
    expectedPolicyId: 'POL-REFUND-OUTAGE',
  },
  {
    id: 'trial-extension',
    query: 'Could I get more time in my trial?',
    expectedPolicyId: 'POL-TRIAL-EXTEND',
  },
  {
    id: 'stolen-card',
    query: 'Someone used my stolen card.',
    expectedPolicyId: 'POL-DISPUTE-ESCALATE',
  },
  {
    id: 'unexpected-invoice-increase',
    query: 'My next invoice is much higher than I expected.',
    expectedPolicyId: 'POL-REFUND-STANDARD',
  },
];
