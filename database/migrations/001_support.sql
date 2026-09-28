CREATE TABLE policies (
  id TEXT PRIMARY KEY,
  category TEXT NOT NULL CHECK (category IN ('refund', 'cancellation', 'account_tier', 'dispute')),
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  full_text TEXT NOT NULL,
  max_auto_approved_cents BIGINT NOT NULL CHECK (max_auto_approved_cents >= 0),
  min_tenure_days INTEGER NOT NULL CHECK (min_tenure_days >= 0),
  refund_window_days INTEGER CHECK (refund_window_days >= 0),
  keywords TEXT[] NOT NULL DEFAULT '{}'
);

CREATE TABLE customers (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  tenure_days INTEGER NOT NULL CHECK (tenure_days >= 0),
  tier TEXT NOT NULL CHECK (tier IN ('free', 'starter', 'enterprise')),
  risk_score INTEGER NOT NULL CHECK (risk_score BETWEEN 0 AND 100)
);

CREATE TABLE invoices (
  id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL REFERENCES customers(id),
  amount_cents BIGINT NOT NULL CHECK (amount_cents > 0),
  refunded_amount_cents BIGINT NOT NULL DEFAULT 0 CHECK (refunded_amount_cents >= 0),
  currency CHAR(3) NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('paid', 'partially_refunded', 'refunded', 'disputed')),
  issued_at TIMESTAMPTZ NOT NULL,
  CHECK (refunded_amount_cents <= amount_cents)
);

CREATE TABLE tickets (
  id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL REFERENCES customers(id),
  subject TEXT NOT NULL,
  raw_message TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('open', 'pending_approval', 'resolved', 'rejected')),
  created_at TIMESTAMPTZ NOT NULL,
  resolved_at TIMESTAMPTZ
);

CREATE TABLE action_proposals (
  id TEXT PRIMARY KEY,
  ticket_id TEXT NOT NULL REFERENCES tickets(id),
  customer_id TEXT NOT NULL REFERENCES customers(id),
  action_type TEXT NOT NULL CHECK (action_type IN ('ISSUE_REFUND', 'EXTEND_TRIAL', 'CREDIT_ACCOUNT', 'ESCALATE_TIER2')),
  target_invoice_id TEXT REFERENCES invoices(id),
  amount_cents BIGINT CHECK (amount_cents > 0),
  matched_policy_id TEXT NOT NULL REFERENCES policies(id),
  policy_citation TEXT NOT NULL,
  requires_human_approval BOOLEAN NOT NULL,
  approval_reason TEXT,
  status TEXT NOT NULL CHECK (status IN ('PROPOSED', 'APPROVED', 'REJECTED', 'EXECUTED')),
  created_at TIMESTAMPTZ NOT NULL,
  executed_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX one_open_refund_per_invoice
  ON action_proposals(ticket_id, target_invoice_id)
  WHERE action_type = 'ISSUE_REFUND' AND status IN ('PROPOSED', 'APPROVED');

CREATE INDEX tickets_queue_order ON tickets(status, created_at DESC, id);
CREATE INDEX proposals_by_ticket ON action_proposals(ticket_id, created_at);

CREATE TABLE idempotency_records (
  operation TEXT NOT NULL CHECK (operation IN ('refund-proposal', 'refund-decision', 'refund-execution')),
  key TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  response JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY(operation, key)
);

CREATE TABLE audit_logs (
  id TEXT PRIMARY KEY,
  timestamp TIMESTAMPTZ NOT NULL,
  actor TEXT NOT NULL CHECK (actor IN ('SYSTEM', 'OPERATOR')),
  operator_id TEXT,
  action_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  details JSONB NOT NULL DEFAULT '{}'
);

CREATE INDEX audit_by_entity ON audit_logs(entity_id, timestamp);
