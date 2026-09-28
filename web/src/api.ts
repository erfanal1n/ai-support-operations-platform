import type { TicketContext, TicketStatus, TicketSummary } from './types';

export interface OperatorSession {
  id: string;
  role: 'agent' | 'supervisor';
}

export interface SessionStatus {
  authRequired: boolean;
  operator: OperatorSession | null;
}

interface ApiErrorBody {
  error?: { code?: string; message?: string };
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    ...init,
    credentials: init.credentials ?? 'same-origin',
    headers: {
      ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...init.headers,
    },
  });
  const body = (await response.json().catch(() => null)) as T | ApiErrorBody | null;

  if (!response.ok) {
    const message = (body as ApiErrorBody | null)?.error?.message;
    throw new Error(message ?? `Request failed (${response.status})`);
  }

  if (body === null) throw new Error('The server returned an empty response');
  return body as T;
}

export function fetchSession(signal?: AbortSignal): Promise<SessionStatus> {
  return request<SessionStatus>('/api/session', { signal });
}

export function loginOperator(id: string, token: string): Promise<{ operator: OperatorSession }> {
  return request('/api/session/login', { method: 'POST', body: JSON.stringify({ id, token }) });
}

export function logoutOperator(): Promise<{ ok: boolean }> {
  return request('/api/session/logout', { method: 'POST' });
}

export async function fetchTickets(signal?: AbortSignal): Promise<TicketSummary[]> {
  const response = await request<{ tickets: TicketSummary[] }>('/api/tickets', { signal });
  return response.tickets;
}

export function fetchTicket(ticketId: string, signal?: AbortSignal): Promise<TicketContext> {
  return request<TicketContext>(`/api/tickets/${encodeURIComponent(ticketId)}`, { signal });
}

export function createRefundProposal(
  ticketId: string,
  input: { invoiceId: string; policyId: string; amountCents: number },
  idempotencyKey: string
) {
  return request<{ proposal: TicketContext['proposals'][number]; replayed: boolean }>(
    `/api/tickets/${encodeURIComponent(ticketId)}/refund-proposals`,
    {
      method: 'POST',
      headers: { 'Idempotency-Key': idempotencyKey },
      body: JSON.stringify(input),
    }
  );
}

export function decideRefundProposal(
  proposalId: string,
  decision: 'APPROVE' | 'REJECT',
  operatorId: string,
  idempotencyKey: string
) {
  return request<{ proposal: TicketContext['proposals'][number]; replayed: boolean }>(
    `/api/refund-proposals/${encodeURIComponent(proposalId)}/decision`,
    {
      method: 'POST',
      headers: { 'Idempotency-Key': idempotencyKey },
      body: JSON.stringify({ decision, operatorId }),
    }
  );
}

export function executeRefundProposal(proposalId: string, idempotencyKey: string) {
  return request<{ proposal: TicketContext['proposals'][number]; invoice: TicketContext['invoices'][number]; replayed: boolean }>(
    `/api/refund-proposals/${encodeURIComponent(proposalId)}/execute`,
    {
      method: 'POST',
      headers: { 'Idempotency-Key': idempotencyKey },
    }
  );
}

export function fetchTicketsByStatus(status: TicketStatus, signal?: AbortSignal): Promise<TicketSummary[]> {
  return request<{ tickets: TicketSummary[] }>(`/api/tickets?status=${status}`, { signal }).then(
    ({ tickets }) => tickets
  );
}
