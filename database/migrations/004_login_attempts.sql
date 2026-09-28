CREATE TABLE auth_login_attempts (
  attempt_key TEXT PRIMARY KEY CHECK (attempt_key ~ '^[0-9a-f]{64}$'),
  window_started_at TIMESTAMPTZ NOT NULL,
  attempts INTEGER NOT NULL CHECK (attempts > 0)
);

CREATE INDEX auth_login_attempts_expiry ON auth_login_attempts(window_started_at);
