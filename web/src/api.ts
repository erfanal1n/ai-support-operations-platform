import type { TicketContext, TicketStatus, TicketSummary } from './types';

interface ApiErrorBody {
  error?: { code?: string; message?: string };
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    ...init,
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
