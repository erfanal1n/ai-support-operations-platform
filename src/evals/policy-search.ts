import type { PolicyRule } from '../core/types.js';
import { searchPolicies, type PolicySearchEngine } from '../support/policy-search.js';

export interface PolicySearchCase {
  id: string;
  query: string;
  expectedPolicyId: string;
}

export interface PolicySearchReport {
  k: number;
  total: number;
  hits: number;
  recallAtK: number;
  misses: Array<{
    caseId: string;
    expectedPolicyId: string;
    returnedPolicyIds: string[];
  }>;
}

export function evaluatePolicySearch(
  policies: Iterable<PolicyRule>,
  scenarios: PolicySearchCase[],
  k = 3
): PolicySearchReport {
  if (!Number.isSafeInteger(k) || k < 1) {
    throw new RangeError('k must be a positive integer');
  }

  const policyList = Array.from(policies);
  let hits = 0;
  const misses: PolicySearchReport['misses'] = [];

  for (const scenario of scenarios) {
    const returnedPolicyIds = searchPolicies(policyList, scenario.query, k).map(({ policy }) => policy.id);
    if (returnedPolicyIds.includes(scenario.expectedPolicyId)) {
      hits += 1;
      continue;
    }

    misses.push({
      caseId: scenario.id,
      expectedPolicyId: scenario.expectedPolicyId,
      returnedPolicyIds,
    });
  }

  return {
    k,
    total: scenarios.length,
    hits,
    recallAtK: scenarios.length === 0 ? 0 : hits / scenarios.length,
    misses,
  };
}

export async function evaluatePolicyRetriever(
  policies: Iterable<PolicyRule>,
  scenarios: PolicySearchCase[],
  searcher: PolicySearchEngine,
  k = 3
): Promise<PolicySearchReport> {
  if (!Number.isSafeInteger(k) || k < 1) {
    throw new RangeError('k must be a positive integer');
  }

  const policyList = Array.from(policies);
  let hits = 0;
  const misses: PolicySearchReport['misses'] = [];

  for (const scenario of scenarios) {
    const returnedPolicyIds = (await searcher.search(policyList, scenario.query, k)).map(({ policy }) => policy.id);
    if (returnedPolicyIds.includes(scenario.expectedPolicyId)) {
      hits += 1;
      continue;
    }

    misses.push({
      caseId: scenario.id,
      expectedPolicyId: scenario.expectedPolicyId,
      returnedPolicyIds,
    });
  }

  return {
    k,
    total: scenarios.length,
    hits,
    recallAtK: scenarios.length === 0 ? 0 : hits / scenarios.length,
    misses,
  };
}
