import type { PolicyRule } from '../core/types.js';

export interface PolicySearchHit {
  policy: PolicyRule;
  matchedKeywords: string[];
  score: number;
}

function normalizeText(value: string): string {
  return value.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

export function searchPolicies(
  policies: Iterable<PolicyRule>,
  query: string,
  limit = 3
): PolicySearchHit[] {
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new RangeError('limit must be a positive integer');
  }

  const normalizedQuery = normalizeText(query);
  if (!normalizedQuery) return [];

  const queryPhrase = ` ${normalizedQuery} `;
  const hits: PolicySearchHit[] = [];

  for (const policy of policies) {
    const matchedKeywords = policy.keywords.filter((keyword) => {
      const phrase = normalizeText(keyword);
      return phrase.length > 0 && queryPhrase.includes(` ${phrase} `);
    });

    if (matchedKeywords.length === 0) continue;

    const score = matchedKeywords.reduce(
      (sum, keyword) => sum + normalizeText(keyword).split(' ').length,
      0
    );
    hits.push({ policy, matchedKeywords, score });
  }

  return hits
    .sort((left, right) => right.score - left.score || left.policy.id.localeCompare(right.policy.id))
    .slice(0, limit);
}
