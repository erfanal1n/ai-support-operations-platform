INSERT INTO policies (id, category, title, summary, full_text, max_auto_approved_cents, min_tenure_days, refund_window_days, keywords)
VALUES
  ('POL-REFUND-STANDARD', 'refund', 'Standard Subscription Refund Policy', 'Refunds permitted for billing issues within 14 days of invoice.', 'Customers may request a full or partial refund within 14 days of billing if service expectations were not met. Automatic approval is limited to $50.00. Amounts above $50.00 or accounts under 30 days tenure require supervisor approval.', 5000, 30, 14, ARRAY['refund', 'double charge', 'charged twice', 'two charges', 'duplicate charge', 'billed twice', 'billing mistake', 'money back']),
  ('POL-REFUND-OUTAGE', 'refund', 'Platform Service Outage Compensation', 'Pro-rated credit or refund for verified system downtime.', 'In the event of an unplanned platform outage exceeding 2 hours, affected accounts may be credited or refunded up to $150.00 automatically.', 15000, 0, NULL, ARRAY['outage', 'downtime', 'server down', 'incident', 'offline']),
  ('POL-TRIAL-EXTEND', 'account_tier', 'Evaluation Trial Extension', 'Permits 7-day trial extension for accounts actively testing features.', 'Trial accounts with ongoing technical evaluation may be granted one 7-day extension. Automatic approval applies if risk score is under 25.', 0, 0, NULL, ARRAY['extend trial', 'more time', 'testing period', 'trial expired']),
  ('POL-DISPUTE-ESCALATE', 'dispute', 'Fraud and Chargeback Risk Escalation', 'Immediate escalation to Risk Operations on chargeback threats.', 'Any explicit mention of unauthorized card usage, bank dispute, or lawyer escalation must bypass auto-actions and transition ticket directly to Tier 2 Risk Operations.', 0, 0, NULL, ARRAY['fraud', 'stolen card', 'chargeback', 'bank dispute', 'unauthorized transaction'])
ON CONFLICT (id) DO NOTHING;

INSERT INTO customers (id, email, name, tenure_days, tier, risk_score)
VALUES
  ('cust_acme_corp', 'billing@harborline.example', 'Harborline Analytics', 140, 'enterprise', 5),
  ('cust_solo_dev', 'alex@devstudio.io', 'Alex Rivera', 12, 'starter', 18),
  ('cust_suspicious_user', 'morgan@customer.example', 'Morgan Hayes', 2, 'free', 82)
ON CONFLICT (id) DO NOTHING;

INSERT INTO invoices (id, customer_id, amount_cents, refunded_amount_cents, currency, status, issued_at)
VALUES
  ('inv_acme_001', 'cust_acme_corp', 4900, 0, 'USD', 'paid', NOW() - INTERVAL '4 days'),
  ('inv_acme_002', 'cust_acme_corp', 18000, 0, 'USD', 'paid', NOW() - INTERVAL '2 days'),
  ('inv_solo_001', 'cust_solo_dev', 2900, 0, 'USD', 'paid', NOW() - INTERVAL '6 days'),
  ('inv_solo_002', 'cust_solo_dev', 2900, 0, 'USD', 'paid', NOW() - INTERVAL '6 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO tickets (id, customer_id, subject, raw_message, status, created_at)
VALUES
  ('ticket_solo_duplicate_charge', 'cust_solo_dev', 'Possible duplicate $29 charge', 'I was charged twice for the same $29 plan today. The statement shows two entries for this plan.', 'open', NOW() - INTERVAL '20 minutes'),
  ('ticket_acme_refund_review', 'cust_acme_corp', 'Refund request for the $180 plan', 'Please refund the latest invoice for $180.00. I no longer need the upgraded plan.', 'open', NOW() - INTERVAL '50 minutes'),
  ('ticket_card_dispute', 'cust_suspicious_user', 'I may dispute this card charge', 'I do not recognize this charge and may file a bank dispute.', 'open', NOW() - INTERVAL '2 hours')
ON CONFLICT (id) DO NOTHING;
