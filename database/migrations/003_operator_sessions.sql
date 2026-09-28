CREATE TABLE operator_sessions (
  session_hash TEXT PRIMARY KEY CHECK (session_hash ~ '^[0-9a-f]{64}$'),
  operator_id TEXT NOT NULL CHECK (length(operator_id) BETWEEN 1 AND 120),
  credential_hash TEXT NOT NULL CHECK (credential_hash ~ '^[0-9a-f]{64}$'),
  expires_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX operator_sessions_expiry ON operator_sessions(expires_at);
