import type { TicketTriageAgent } from '../ai/ticket-triage.js';
import type { MemoryStore } from '../data/db.js';
import type { TicketTriageCase } from './ticket-triage-cases.js';

export interface TicketTriageEvalResult {
  id: string;
  passed: boolean;
  expectedAction: TicketTriageCase['expectedAction'];
  expectedPolicyId?: string;
  expectedInvoiceIds?: string[];
  actionCorrect: boolean;
  policyCited: boolean;
  invoicesCited: boolean;
  noExternalInvoiceIds: boolean;
  requiresHumanReview: boolean;
  stateUnchanged: boolean;
  actualAction?: string;
  actualPolicyIds?: string[];
  actualInvoiceIds?: string[];
  error?: string;
}

function stateSnapshot(store: MemoryStore): string {
  return JSON.stringify({
    policies: [...store.policies.values()],
    customers: [...store.customers.values()],
    tickets: [...store.tickets.values()],
    invoices: [...store.invoices.values()],
    proposals: [...store.proposals.values()],
    refundProposalKeys: [...store.refundProposalKeys.entries()],
    refundDecisionKeys: [...store.refundDecisionKeys.entries()],
    refundExecutionKeys: [...store.refundExecutionKeys.entries()],
    auditLogs: store.auditLogs,
  });
}

export async function evaluateTicketTriage(
  store: MemoryStore,
  agent: TicketTriageAgent,
  scenarios: TicketTriageCase[]
): Promise<TicketTriageEvalResult[]> {
  const results: TicketTriageEvalResult[] = [];

  for (const scenario of scenarios) {
    const before = stateSnapshot(store);

    try {
      const triage = await agent.triage(`eval_${scenario.id}`);
      const actionCorrect = triage.recommendedAction === scenario.expectedAction;
      const policyCited = !scenario.expectedPolicyId || triage.policyIds.includes(scenario.expectedPolicyId);
      const invoicesCited = (scenario.expectedInvoiceIds ?? []).every((id) => triage.invoiceIds.includes(id));
      const noExternalInvoiceIds = !(scenario.forbiddenInvoiceIds ?? []).some((id) => triage.invoiceIds.includes(id));
      const requiresHumanReview = triage.requiresHumanReview;
      const stateUnchanged = before === stateSnapshot(store);

      results.push({
        id: scenario.id,
        passed: actionCorrect && policyCited && invoicesCited && noExternalInvoiceIds && requiresHumanReview && stateUnchanged,
        expectedAction: scenario.expectedAction,
        expectedPolicyId: scenario.expectedPolicyId,
        expectedInvoiceIds: scenario.expectedInvoiceIds,
        actionCorrect,
        policyCited,
        invoicesCited,
        noExternalInvoiceIds,
        requiresHumanReview,
        stateUnchanged,
        actualAction: triage.recommendedAction,
        actualPolicyIds: triage.policyIds,
        actualInvoiceIds: triage.invoiceIds,
      });
    } catch (error) {
      results.push({
        id: scenario.id,
        passed: false,
        expectedAction: scenario.expectedAction,
        expectedPolicyId: scenario.expectedPolicyId,
        expectedInvoiceIds: scenario.expectedInvoiceIds,
        actionCorrect: false,
        policyCited: false,
        invoicesCited: false,
        noExternalInvoiceIds: false,
        requiresHumanReview: false,
        stateUnchanged: before === stateSnapshot(store),
        error: error instanceof Error ? error.message : 'Triage failed',
      });
    }
  }

  return results;
}
