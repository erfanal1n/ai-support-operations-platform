import type { Config } from '../config/env.js';
import { OpenAIEmbeddingProvider } from '../ai/embeddings.js';
import { searchPolicies, type PolicySearchEngine } from './policy-search.js';
import { SemanticPolicySearch } from './semantic-policy-search.js';

export function createPolicySearch(config: Config): PolicySearchEngine {
  if (config.POLICY_RETRIEVAL_MODE === 'keyword') {
    return {
      async search(policies, query, limit) {
        return searchPolicies(policies, query, limit);
      },
    };
  }

  if (!config.OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY is required for semantic policy retrieval');
  }

  return new SemanticPolicySearch(
    new OpenAIEmbeddingProvider(config.OPENAI_API_KEY, config.OPENAI_EMBEDDING_MODEL)
  );
}
