import type { TicketContext, TicketStatus, TicketSummary, TicketTriageResult } from './types';

export interface OperatorSession {
  id: string;
  role: 'agent' | 'supervisor';
}

export interface SessionStatus {
  authRequired: boolean;
  operator: OperatorSession | null;
  triageEnabled: boolean;
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

export interface TriageProgress {
  stage: 'ticket_loaded' | 'policies_retrieved' | 'invoices_retrieved' | 'drafting' | 'review_ready';
}

export async function triageTicket(
  ticketId: string,
  runId: string,
  signal: AbortSignal,
  onProgress: (progress: TriageProgress) => void
): Promise<{ triage: TicketTriageResult }> {
  const response = await fetch(`/api/tickets/${encodeURIComponent(ticketId)}/triage/stream`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'X-Triage-Run-Id': runId },
    signal,
  });

  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as ApiErrorBody | null;
    throw new Error(body?.error?.message ?? `Request failed (${response.status})`);
  }
  if (!response.body) throw new Error('The server did not start the triage stream');

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let result: TicketTriageResult | null = null;
  let streamError: Error | null = null;

  function dispatch(block: string) {
    let event = 'message';
    const data: string[] = [];

    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
    }

    if (!data.length) return;
    const payload = JSON.parse(data.join('\n')) as TriageProgress | TicketTriageResult | { message?: string };
    if (event === 'progress' && 'stage' in payload) onProgress(payload);
    if (event === 'result') result = payload as TicketTriageResult;
    if (event === 'error') {
      streamError = new Error('message' in payload && payload.message ? payload.message : 'Triage could not be completed.');
    }
  }

  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    const blocks = buffer.split(/\r?\n\r?\n/);
    buffer = blocks.pop() ?? '';
    for (const block of blocks) dispatch(block);
    if (done) {
      if (buffer.trim()) dispatch(buffer);
      break;
    }
  }

  if (streamError) throw streamError;
  if (!result) throw new Error('The triage stream ended before a result was returned');
  return { triage: result };
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
