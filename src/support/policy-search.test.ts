import { describe, expect, it } from 'vitest';
import { db } from '../data/db.js';
import { policySearchCases } from '../evals/policy-search-cases.js';
import { evaluatePolicySearch } from '../evals/policy-search.js';
import { searchPolicies } from './policy-search.js';

describe('searchPolicies', () => {
  it('matches normalized phrases and returns evidence for each hit', () => {
    const hits = searchPolicies(db.policies.values(), 'I was CHARGED, TWICE!', 3);

    expect(hits[0]?.policy.id).toBe('POL-REFUND-STANDARD');
    expect(hits[0]?.matchedKeywords).toContain('charged twice');
  });

  it('returns no policy when the query has no configured phrase', () => {
    expect(searchPolicies(db.policies.values(), 'Can someone explain my bill?', 3)).toEqual([]);
  });
});

describe('evaluatePolicySearch', () => {
  it('reports recall and leaves misses visible', () => {
    const report = evaluatePolicySearch(db.policies.values(), policySearchCases, 3);

    expect(report).toMatchObject({
      k: 3,
      total: 6,
      hits: 5,
      recallAtK: 5 / 6,
    });
    expect(report.misses).toEqual([
      {
        caseId: 'unexpected-invoice-increase',
        expectedPolicyId: 'POL-REFUND-STANDARD',
        returnedPolicyIds: [],
      },
    ]);
  });
});
