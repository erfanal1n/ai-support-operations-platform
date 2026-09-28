import { db } from '../data/db.js';
import { policySearchCases } from './policy-search-cases.js';
import { evaluatePolicySearch } from './policy-search.js';

const report = evaluatePolicySearch(db.policies.values(), policySearchCases, 3);
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
