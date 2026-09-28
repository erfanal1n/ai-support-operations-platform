import { env } from '../config/env.js';
import { db } from '../data/db.js';
import { policySearchCases } from './policy-search-cases.js';
import { evaluatePolicyRetriever, evaluatePolicySearch } from './policy-search.js';
import { createPolicySearch } from '../support/policy-retrieval.js';

const report = env.POLICY_RETRIEVAL_MODE === 'keyword'
  ? evaluatePolicySearch(db.policies.values(), policySearchCases, 3)
  : await evaluatePolicyRetriever(db.policies.values(), policySearchCases, createPolicySearch(env), 3);

process.stdout.write(`${JSON.stringify({ mode: env.POLICY_RETRIEVAL_MODE, ...report }, null, 2)}\n`);
