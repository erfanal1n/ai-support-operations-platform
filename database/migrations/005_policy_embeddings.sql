CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE policy_embeddings (
  policy_id TEXT NOT NULL REFERENCES policies(id) ON DELETE CASCADE,
  model TEXT NOT NULL,
  source_hash TEXT NOT NULL CHECK (source_hash ~ '^[0-9a-f]{64}$'),
  embedding vector(1536) NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (policy_id, model)
);

CREATE INDEX policy_embeddings_cosine ON policy_embeddings
  USING hnsw (embedding vector_cosine_ops);
