# Security notes

This service handles support case text, invoice records, operator credentials, and refund decisions. Its seed data is synthetic. It is not configured for real customer records or real payment execution.

## Boundaries

- The browser calls the FastAPI service through the Vite proxy in development or the Nginx proxy in Compose.
- PostgreSQL stores case state, audit records, sessions, policy vectors, and LangGraph checkpoints.
- OpenAI is contacted only when semantic policy search or model-backed triage is enabled.
- The MCP server uses stdio and exposes read-only case and policy tools to its local host process.

## Controls in the application

- Pydantic request models reject unknown fields and bound user-supplied text and identifiers.
- Refund assessment checks the selected invoice belongs to the customer and is refundable, then checks remaining balance, policy window, amount limit, account tenure, and approval state.
- Proposal, decision, and execution calls require idempotency keys. PostgreSQL writes the state changes and audit record in a transaction.
- Session mode stores only a hash of each session identifier. Cookies are HTTP-only and `SameSite=Strict`; production cookies are `Secure`.
- Login throttling keys are HMACs of the client address and operator ID. The database stores the counter, not that pair.
- MCP tools are marked read-only. They cannot create a proposal, approve a decision, or record a refund.
- Triage treats ticket text as untrusted input, validates the model response, rejects policy or invoice citations that were not retrieved, and always returns a result requiring operator review.
- Request logs contain method, path, status, duration, and a generated request ID. They do not include request or response bodies.

## Model data

Semantic search sends the policy text and ticket query to the embedding provider. Triage sends the ticket subject and message, customer tier and tenure, and selected policy and invoice fields to the configured model. Customer name and email are not included in the triage model input. Use synthetic data unless the organization has approved the provider and data handling for its use case.

Triage checkpoint state includes case and evidence IDs, the draft, and usage metadata. It does not include the original ticket message or customer email. Successful runs delete their checkpoint; an incomplete run keeps state for a retry, so the stored draft may still contain ticket-derived text.

## Deployment requirements and limits

- Compose binds service ports to loopback and runs with authentication disabled for local use. Do not expose it to the internet in this configuration.
- Public deployments need TLS, `APP_ENV=production`, `AUTH_MODE=session`, strong generated credentials, PostgreSQL, and secret management outside the repository.
- The application does not encrypt database fields itself. Protect database disks and backups through the deployment environment.
- There is no external identity provider, payment gateway, or real refund execution.
- Model output may still be wrong or incomplete. Citation validation checks provenance, not the correctness of a recommendation; an operator must review it.
