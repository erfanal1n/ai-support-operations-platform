import type { EmbeddingProvider } from '../ai/embeddings.js';
import type { PolicyRule } from '../core/types.js';
import { searchPolicies, type PolicySearchEngine, type PolicySearchHit } from './policy-search.js';

const minimumScore = 0.3;

function policyText(policy: PolicyRule): string {
  return `${policy.title}\n${policy.summary}\n${policy.fullText}`;
}

function assertVector(vector: number[]): void {
  if (vector.length === 0 || vector.some((value) => !Number.isFinite(value))) {
    throw new Error('Embedding provider returned an invalid vector');
  }
}

function cosineSimilarity(left: number[], right: number[]): number {
  if (left.length !== right.length) throw new Error('Embedding dimensions do not match');
  assertVector(left);
  assertVector(right);

  let dot = 0;
  let leftLength = 0;
  let rightLength = 0;

  for (let index = 0; index < left.length; index += 1) {
    const leftValue = left[index]!;
    const rightValue = right[index]!;
    dot += leftValue * rightValue;
    leftLength += leftValue ** 2;
    rightLength += rightValue ** 2;
  }

  if (leftLength === 0 || rightLength === 0) throw new Error('Embedding vector has zero magnitude');
  return dot / (Math.sqrt(leftLength) * Math.sqrt(rightLength));
}

export class SemanticPolicySearch implements PolicySearchEngine {
  private readonly vectors = new Map<string, { source: string; vector: number[] }>();
  private indexing: Promise<void> | null = null;

  constructor(private readonly embeddings: EmbeddingProvider) {}

  async search(policies: Iterable<PolicyRule>, query: string, limit = 3): Promise<PolicySearchHit[]> {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new RangeError('limit must be a positive integer');

    const policyList = Array.from(policies);
    if (policyList.length === 0 || !query.trim()) return [];

    await this.indexPolicies(policyList);
    const [queryVector] = await this.embeddings.embed([query]);
    if (!queryVector) throw new Error('Embedding provider returned no query vector');

    const keywordHits = new Map(
      searchPolicies(policyList, query, policyList.length).map((hit) => [hit.policy.id, hit])
    );

    return policyList
      .map((policy) => {
        const indexed = this.vectors.get(policy.id);
        if (!indexed) throw new Error(`Policy '${policy.id}' was not indexed`);

        const keywordHit = keywordHits.get(policy.id);
        const score = cosineSimilarity(queryVector, indexed.vector) + (keywordHit ? 0.12 : 0);
        return { policy, matchedKeywords: keywordHit?.matchedKeywords ?? [], score };
      })
      .filter((hit) => hit.score >= minimumScore)
      .sort((left, right) => right.score - left.score || left.policy.id.localeCompare(right.policy.id))
      .slice(0, limit);
  }

  private async indexPolicies(policies: PolicyRule[]): Promise<void> {
    if (this.indexing) await this.indexing;

    const activeIds = new Set(policies.map(({ id }) => id));
    for (const id of this.vectors.keys()) {
      if (!activeIds.has(id)) this.vectors.delete(id);
    }

    const missing = policies.filter((policy) => this.vectors.get(policy.id)?.source !== policyText(policy));
    if (missing.length === 0) return;

    const indexing = this.embeddings.embed(missing.map(policyText)).then((vectors) => {
      if (vectors.length !== missing.length) throw new Error('Embedding response did not match the policy count');

      for (const [index, policy] of missing.entries()) {
        const vector = vectors[index];
        if (!vector) throw new Error(`Embedding provider returned no vector for policy '${policy.id}'`);
        assertVector(vector);
        this.vectors.set(policy.id, { source: policyText(policy), vector });
      }
    });

    this.indexing = indexing;
    try {
      await indexing;
    } finally {
      if (this.indexing === indexing) this.indexing = null;
    }
  }
}
