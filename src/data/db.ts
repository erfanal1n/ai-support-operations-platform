import type {
  ActionProposal,
  AuditEntry,
  CustomerProfile,
  InvoiceRecord,
  PolicyRule,
  SupportTicket,
} from '../core/types.js';
import type { OperatorSessionRecord, TicketTriageDataSource } from './repository.js';

export class MemoryStore implements TicketTriageDataSource {
  public readonly policies: Map<string, PolicyRule> = new Map();
  public readonly customers: Map<string, CustomerProfile> = new Map();
  public readonly invoices: Map<string, InvoiceRecord> = new Map();
  public readonly tickets: Map<string, SupportTicket> = new Map();
  public readonly proposals: Map<string, ActionProposal> = new Map();
  public readonly refundProposalKeys = new Map<string, { fingerprint: string; proposal: ActionProposal }>();
  public readonly refundDecisionKeys = new Map<string, { fingerprint: string; proposal: ActionProposal }>();
  public readonly refundExecutionKeys = new Map<
    string,
    { fingerprint: string; proposal: ActionProposal; invoice: InvoiceRecord }
  >();
  public readonly auditLogs: AuditEntry[] = [];
  public readonly operatorSessions = new Map<string, OperatorSessionRecord>();
  public readonly loginAttempts = new Map<string, { windowStartedAt: number; attempts: number }>();

  async getTicket(id: string): Promise<SupportTicket | null> {
    return this.tickets.get(id) ?? null;
  }

  async getCustomer(id: string): Promise<CustomerProfile | null> {
    return this.customers.get(id) ?? null;
  }

  async listCustomerInvoices(customerId: string): Promise<InvoiceRecord[]> {
    return [...this.invoices.values()].filter((invoice) => invoice.customerId === customerId);
  }

  async listPolicies(): Promise<PolicyRule[]> {
    return [...this.policies.values()];
  }

  constructor() {
    this.seedDefaults();
  }

  private seedDefaults(): void {
    const defaultPolicies: PolicyRule[] = [
      {
        id: 'POL-REFUND-STANDARD',
        category: 'refund',
        title: 'Standard Subscription Refund Policy',
        summary: 'Refunds permitted for billing issues within 14 days of invoice.',
        fullText: 'Customers may request a full or partial refund within 14 days of billing if service expectations were not met. Automatic approval is limited to $50.00. Amounts above $50.00 or accounts under 30 days tenure require supervisor approval.',
        maxAutoApprovedCents: 5000,
        minTenureDays: 30,
        refundWindowDays: 14,
        keywords: [
          'refund',
          'double charge',
          'charged twice',
          'two charges',
          'duplicate charge',
          'billed twice',
          'billing mistake',
          'money back',
        ],
      },
      {
        id: 'POL-REFUND-OUTAGE',
        category: 'refund',
        title: 'Platform Service Outage Compensation',
        summary: 'Pro-rated credit or refund for verified system downtime.',
        fullText: 'In the event of an unplanned platform outage exceeding 2 hours, affected accounts may be credited or refunded up to $150.00 automatically.',
        maxAutoApprovedCents: 15000,
        minTenureDays: 0,
        keywords: ['outage', 'downtime', 'server down', 'incident', 'offline'],
      },
      {
        id: 'POL-TRIAL-EXTEND',
        category: 'account_tier',
        title: 'Evaluation Trial Extension',
        summary: 'Permits 7-day trial extension for accounts actively testing features.',
        fullText: 'Trial accounts with ongoing technical evaluation may be granted one 7-day extension. Automatic approval applies if risk score is under 25.',
        maxAutoApprovedCents: 0,
        minTenureDays: 0,
        keywords: ['extend trial', 'more time', 'testing period', 'trial expired'],
      },
      {
        id: 'POL-DISPUTE-ESCALATE',
        category: 'dispute',
        title: 'Fraud and Chargeback Risk Escalation',
        summary: 'Immediate escalation to Risk Operations on chargeback threats.',
        fullText: 'Any explicit mention of unauthorized card usage, bank dispute, or lawyer escalation must bypass auto-actions and transition ticket directly to Tier 2 Risk Operations.',
        maxAutoApprovedCents: 0,
        minTenureDays: 0,
        keywords: ['fraud', 'stolen card', 'chargeback', 'bank dispute', 'unauthorized transaction'],
      },
    ];

    for (const pol of defaultPolicies) {
      this.policies.set(pol.id, pol);
    }

    const defaultCustomers: CustomerProfile[] = [
      {
        id: 'cust_acme_corp',
        email: 'billing@harborline.example',
        name: 'Harborline Analytics',
        tenureDays: 140,
        tier: 'enterprise',
        riskScore: 5,
      },
      {
        id: 'cust_solo_dev',
        email: 'alex@devstudio.io',
        name: 'Alex Rivera',
        tenureDays: 12,
        tier: 'starter',
        riskScore: 18,
      },
      {
        id: 'cust_suspicious_user',
        email: 'morgan@customer.example',
        name: 'Morgan Hayes',
        tenureDays: 2,
        tier: 'free',
        riskScore: 82,
      },
    ];

    for (const cust of defaultCustomers) {
      this.customers.set(cust.id, cust);
    }

    const soloInvoiceIssuedAt = new Date(Date.now() - 6 * 86400000).toISOString();
    const defaultInvoices: InvoiceRecord[] = [
      {
        id: 'inv_acme_001',
        customerId: 'cust_acme_corp',
        amountCents: 4900,
        refundedAmountCents: 0,
        currency: 'USD',
        status: 'paid',
        issuedAt: new Date(Date.now() - 4 * 86400000).toISOString(),
      },
      {
        id: 'inv_acme_002',
        customerId: 'cust_acme_corp',
        amountCents: 18000,
        refundedAmountCents: 0,
        currency: 'USD',
        status: 'paid',
        issuedAt: new Date(Date.now() - 2 * 86400000).toISOString(),
      },
      {
        id: 'inv_solo_001',
        customerId: 'cust_solo_dev',
        amountCents: 2900,
        refundedAmountCents: 0,
        currency: 'USD',
        status: 'paid',
        issuedAt: soloInvoiceIssuedAt,
      },
      {
        id: 'inv_solo_002',
        customerId: 'cust_solo_dev',
        amountCents: 2900,
        refundedAmountCents: 0,
        currency: 'USD',
        status: 'paid',
        issuedAt: soloInvoiceIssuedAt,
      },
    ];

    for (const inv of defaultInvoices) {
      this.invoices.set(inv.id, inv);
    }

    const demoTickets: SupportTicket[] = [
      {
        id: 'ticket_solo_duplicate_charge',
        customerId: 'cust_solo_dev',
        subject: 'Possible duplicate $29 charge',
        rawMessage: 'I was charged twice for the same $29 plan today. The statement shows two entries for this plan.',
        status: 'open',
        createdAt: new Date(Date.now() - 20 * 60000).toISOString(),
      },
      {
        id: 'ticket_acme_refund_review',
        customerId: 'cust_acme_corp',
        subject: 'Refund request for the $180 plan',
        rawMessage: 'Please refund the latest invoice for $180.00. I no longer need the upgraded plan.',
        status: 'open',
        createdAt: new Date(Date.now() - 50 * 60000).toISOString(),
      },
      {
        id: 'ticket_card_dispute',
        customerId: 'cust_suspicious_user',
        subject: 'I may dispute this card charge',
        rawMessage: 'I do not recognize this charge and may file a bank dispute.',
        status: 'open',
        createdAt: new Date(Date.now() - 2 * 3600000).toISOString(),
      },
    ];

    for (const ticket of demoTickets) {
      this.tickets.set(ticket.id, ticket);
    }
  }

  public appendAudit(
    actor: 'SYSTEM' | 'OPERATOR',
    actionType: string,
    entityId: string,
    details: Record<string, unknown>,
    operatorId?: string
  ): AuditEntry {
    const entry: AuditEntry = {
      id: `audit_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      timestamp: new Date().toISOString(),
      actor,
      operatorId,
      actionType,
      entityId,
      details,
    };
    this.auditLogs.push(entry);
    return entry;
  }
}

export const db = new MemoryStore();
