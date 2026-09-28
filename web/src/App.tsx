import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { createRefundProposal, decideRefundProposal, executeRefundProposal, fetchTicket, fetchTickets } from './api';
import type { TicketContext, TicketStatus, TicketSummary } from './types';

type QueueFilter = 'all' | 'pending_approval';

function Icon({ name }: { name: 'inbox' | 'search' | 'receipt' | 'shield' | 'clock' }) {
  const paths = {
    inbox: <><path d="M4 4h16v12h-4l-2 3h-4l-2-3H4z" /><path d="M4 12h5l2 2h2l2-2h5" /></>,
    search: <><circle cx="11" cy="11" r="6" /><path d="m16 16 4 4" /></>,
    receipt: <><path d="M6 3h12v18l-3-2-3 2-3-2-3 2z" /><path d="M9 8h6M9 12h6" /></>,
    shield: <><path d="M12 3 19 6v5c0 4.5-3 7.5-7 10-4-2.5-7-5.5-7-10V6z" /><path d="m9 12 2 2 4-4" /></>,
    clock: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>,
  };

  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      {paths[name]}
    </svg>
  );
}

function formatMoney(amountCents: number, currency: string): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(amountCents / 100);
}

function invoiceLabel(invoices: TicketContext['invoices'], invoiceId?: string): string {
  const index = invoices.findIndex((invoice) => invoice.id === invoiceId);
  return index < 0 ? 'Account invoice' : `Invoice ${index + 1}`;
}

function approvalReasonText(reason: string): string {
  return reason
    .split(',')
    .map((item) => item.trim().replaceAll('_', ' '))
    .map((item) => item.charAt(0).toUpperCase() + item.slice(1))
    .join('; ');
}

function relativeTime(timestamp: string): string {
  const elapsed = Date.now() - Date.parse(timestamp);
  if (!Number.isFinite(elapsed) || elapsed < 0) return 'just now';
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function statusLabel(status: TicketStatus): string {
  if (status === 'pending_approval') return 'Needs approval';
  if (status === 'resolved') return 'Resolved';
  if (status === 'rejected') return 'Rejected';
  return 'Open';
}

function caseType(subject: string): string {
  const normalized = subject.toLowerCase();
  if (normalized.includes('dispute') || normalized.includes('card')) return 'Risk review';
  if (normalized.includes('refund') || normalized.includes('charge')) return 'Billing';
  return 'Support';
}

function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join('');
}

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <article className="metric-card">
      <div className="metric-copy">
        <p>{label}</p>
        <strong>{value}</strong>
      </div>
    </article>
  );
}

function TicketRow({ ticket, selected, onSelect }: { ticket: TicketSummary; selected: boolean; onSelect: () => void }) {
  return (
    <button className={`ticket-row${selected ? ' selected' : ''}`} aria-pressed={selected} onClick={onSelect} type="button">
      <span className={`ticket-avatar ${ticket.customer.tier}`}>{initials(ticket.customer.name)}</span>
      <span className="ticket-copy">
        <span className="ticket-row-top">
          <strong>{ticket.subject}</strong>
          <small>{relativeTime(ticket.createdAt)}</small>
        </span>
        <span className="ticket-row-bottom">
          <span>{ticket.customer.name}</span>
          <span className={`case-kind ${caseType(ticket.subject) === 'Risk review' ? 'risk' : ''}`}>
            {caseType(ticket.subject)}
          </span>
        </span>
      </span>
      <span className={`ticket-status ${ticket.status}`}>{statusLabel(ticket.status)}</span>
    </button>
  );
}

interface TicketDetailProps {
  context: TicketContext;
  operatorId: string;
  actionPending: boolean;
  onOperatorChange: (value: string) => void;
  onPropose: (input: { invoiceId: string; policyId: string; amountCents: number }) => void;
  onDecision: (proposalId: string, decision: 'APPROVE' | 'REJECT') => void;
  onExecute: (proposalId: string) => void;
}

function TicketDetail({ context, operatorId, actionPending, onOperatorChange, onPropose, onDecision, onExecute }: TicketDetailProps) {
  const { ticket, customer, invoices, relevantPolicies, proposals } = context;
  const refundableInvoices = invoices.filter((invoice) => invoice.status !== 'disputed' && invoice.amountCents > invoice.refundedAmountCents);
  const refundPolicies = relevantPolicies.filter((policy) => policy.category === 'refund');
  const [invoiceId, setInvoiceId] = useState(refundableInvoices[0]?.id ?? '');
  const [policyId, setPolicyId] = useState(refundPolicies[0]?.id ?? '');
  const [amount, setAmount] = useState('');
  const selectedInvoice = refundableInvoices.find((invoice) => invoice.id === invoiceId) ?? refundableInvoices[0];
  const remainingCents = selectedInvoice ? selectedInvoice.amountCents - selectedInvoice.refundedAmountCents : 0;
  const canProposeRefund = ticket.status === 'open' && refundPolicies.length > 0 && refundableInvoices.length > 0;

  useEffect(() => {
    if (!refundableInvoices.some((invoice) => invoice.id === invoiceId)) {
      setInvoiceId(refundableInvoices[0]?.id ?? '');
    }
    if (!refundPolicies.some((policy) => policy.id === policyId)) {
      setPolicyId(refundPolicies[0]?.id ?? '');
    }
  }, [context.ticket.id, invoices, relevantPolicies]);

  useEffect(() => {
    setAmount(remainingCents > 0 ? (remainingCents / 100).toFixed(2) : '');
  }, [context.ticket.id, selectedInvoice?.id, selectedInvoice?.refundedAmountCents, selectedInvoice?.amountCents]);

  function submitProposal(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const amountCents = Math.round(Number(amount) * 100);
    if (!invoiceId || !policyId || !Number.isSafeInteger(amountCents) || amountCents < 1 || amountCents > remainingCents) return;
    onPropose({ invoiceId, policyId, amountCents });
  }

  return (
    <div className="detail-stack">
      <section className="case-heading">
        <div className="case-title-block">
          <div className="case-overline">
            <span className={`status-pill ${ticket.status}`}>{statusLabel(ticket.status)}</span>
          </div>
          <h2>{ticket.subject}</h2>
          <p className="case-subtitle">Received {relativeTime(ticket.createdAt)} · {caseType(ticket.subject)}</p>
        </div>
      </section>

      <section className="customer-strip" aria-label="Customer summary">
        <div className={`customer-avatar ${customer.tier}`}>{initials(customer.name)}</div>
        <div className="customer-identity">
          <strong>{customer.name}</strong>
        </div>
        <span className={`tier-pill ${customer.tier}`}>{customer.tier}</span>
        <span className="customer-tenure">Customer for <b>{customer.tenureDays} days</b></span>
      </section>

      <section className="message-card">
        <div className="section-heading">
          <div>
            <h3>Customer message</h3>
          </div>
          <span className="message-time"><Icon name="clock" /> {relativeTime(ticket.createdAt)}</span>
        </div>
        <blockquote>{ticket.rawMessage}</blockquote>
      </section>

      <section className="evidence-grid">
        <div className="evidence-card">
          <div className="section-heading compact">
            <h3>Invoices</h3>
            <span className="count-pill">{invoices.length}</span>
          </div>
          {invoices.length === 0 ? <p className="empty-note">No invoices found for this account.</p> : (
            <div className="invoice-list">
              {invoices.map((invoice) => (
                <div className="invoice-row" key={invoice.id}>
                  <div className="invoice-id"><strong>{invoiceLabel(invoices, invoice.id)}</strong><span>{new Date(invoice.issuedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</span></div>
                  <div className="invoice-amount"><strong>{formatMoney(invoice.amountCents, invoice.currency)}</strong><span>{invoice.refundedAmountCents > 0 ? `${formatMoney(invoice.refundedAmountCents, invoice.currency)} refunded` : invoice.status.replace('_', ' ')}</span></div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="evidence-card policy-card">
          <div className="section-heading compact">
            <h3>Matched policy</h3>
            <span className="count-pill">{relevantPolicies.length}</span>
          </div>
          {relevantPolicies.length === 0 ? <p className="empty-note">No policy phrase matched. Review the request manually.</p> : (
            <div className="policy-list">
              {relevantPolicies.map((policy) => (
                <article className="policy-evidence" key={policy.id}>
                  <div className="policy-title-row"><strong>{policy.title}</strong></div>
                  <p>{policy.summary}</p>
                  <p className="match-phrases">Matched terms: {policy.matchedKeywords.join(', ')}</p>
                  <details><summary>Read policy text</summary><p>{policy.fullText}</p></details>
                </article>
              ))}
            </div>
          )}
        </div>
      </section>

      <section className="action-card">
        <div className="section-heading compact"><h3>Refund proposal</h3></div>
        {canProposeRefund ? (
          <form className="proposal-form" onSubmit={submitProposal}>
            <label>Invoice<select value={invoiceId} onChange={(event) => setInvoiceId(event.target.value)}>{refundableInvoices.map((invoice) => <option key={invoice.id} value={invoice.id}>{invoiceLabel(invoices, invoice.id)} · {formatMoney(invoice.amountCents - invoice.refundedAmountCents, invoice.currency)} remaining</option>)}</select></label>
            <label>Matched policy<select value={policyId} onChange={(event) => setPolicyId(event.target.value)}>{refundPolicies.map((policy) => <option key={policy.id} value={policy.id}>{policy.title}</option>)}</select></label>
            <label>Refund amount<input type="number" min="0.01" max={(remainingCents / 100).toFixed(2)} step="0.01" value={amount} onChange={(event) => setAmount(event.target.value)} /></label>
            <button className="primary-action" type="submit" disabled={actionPending || !amount || Number(amount) <= 0 || Number(amount) * 100 > remainingCents}>Create proposal</button>
          </form>
        ) : (
          <p className="empty-note">{refundPolicies.length === 0
            ? 'No matched refund policy. Review the evidence before taking action.'
            : refundableInvoices.length === 0
              ? 'No refundable invoice is available for this case.'
              : ticket.status !== 'open'
                ? 'Resolve the existing proposal before creating another refund proposal.'
                : 'This case is not open for a new refund proposal.'}</p>
        )}

        {proposals.length > 0 && (
          <div className="proposal-history">
            <div className="section-heading compact"><h3>Previous proposals</h3><span className="count-pill">{proposals.length}</span></div>
              {proposals.map((proposal) => (
              <article className="proposal-item" key={proposal.id}>
                <div className="proposal-row"><span>Refund request · {relativeTime(proposal.createdAt)}</span><strong className={`proposal-status ${proposal.status.toLowerCase()}`}>{proposal.status.toLowerCase()}</strong><b>{formatMoney(proposal.amountCents ?? 0, invoices.find((invoice) => invoice.id === proposal.targetInvoiceId)?.currency ?? 'USD')}</b></div>
                <p>{invoiceLabel(invoices, proposal.targetInvoiceId)} · {relevantPolicies.find((policy) => policy.id === proposal.matchedPolicyId)?.title ?? 'Policy review'}{proposal.approvalReason ? ` · ${approvalReasonText(proposal.approvalReason)}` : ''}</p>
                {proposal.status === 'PROPOSED' && proposal.requiresHumanApproval && (
                  <div className="proposal-actions">
                    <label>Operator label<input value={operatorId} onChange={(event) => onOperatorChange(event.target.value)} placeholder="Your operator ID" /></label>
                    <button type="button" disabled={actionPending || !operatorId.trim()} onClick={() => onDecision(proposal.id, 'APPROVE')}>Approve</button>
                    <button className="quiet-action" type="button" disabled={actionPending || !operatorId.trim()} onClick={() => onDecision(proposal.id, 'REJECT')}>Reject</button>
                  </div>
                )}
                {(proposal.status === 'APPROVED' || (proposal.status === 'PROPOSED' && !proposal.requiresHumanApproval)) && (
                  <div className="proposal-actions"><button className="primary-action" type="button" disabled={actionPending} onClick={() => onExecute(proposal.id)}>Record refund</button></div>
                )}
                {proposal.status === 'EXECUTED' && <span className="execution-note">Refund recorded{proposal.executedAt ? ` · ${relativeTime(proposal.executedAt)}` : ''}</span>}
              </article>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

export default function App() {
  const [tickets, setTickets] = useState<TicketSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [context, setContext] = useState<TicketContext | null>(null);
  const [filter, setFilter] = useState<QueueFilter>('all');
  const [search, setSearch] = useState('');
  const [queueLoading, setQueueLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [error, setError] = useState('');
  const [refreshSequence, setRefreshSequence] = useState(0);
  const [actionPending, setActionPending] = useState(false);
  const [operatorId, setOperatorId] = useState('');

  async function runAction(action: () => Promise<unknown>) {
    setActionPending(true);
    setError('');
    try {
      await action();
      setRefreshSequence((value) => value + 1);
    } catch (reason: unknown) {
      setError(reason instanceof Error ? reason.message : 'The action could not be completed. Refresh the case before trying again.');
    } finally {
      setActionPending(false);
    }
  }

  useEffect(() => {
    const controller = new AbortController();
    fetchTickets(controller.signal)
      .then((records) => {
        setTickets(records);
        setSelectedId((current) => current ?? records[0]?.id ?? null);
      })
      .catch((reason: unknown) => {
        if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : 'Could not load the case queue.');
      })
      .finally(() => {
        if (!controller.signal.aborted) setQueueLoading(false);
      });
    return () => controller.abort();
  }, [refreshSequence]);

  useEffect(() => {
    if (!selectedId) {
      setContext(null);
      return;
    }
    const controller = new AbortController();
    setDetailLoading(true);
    fetchTicket(selectedId, controller.signal)
      .then((record) => setContext(record))
      .catch((reason: unknown) => {
        if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : 'Could not load this case.');
      })
      .finally(() => {
        if (!controller.signal.aborted) setDetailLoading(false);
      });
    return () => controller.abort();
  }, [refreshSequence, selectedId]);

  const pendingCount = useMemo(() => tickets.filter((ticket) => ticket.status === 'pending_approval').length, [tickets]);
  const openCount = useMemo(() => tickets.filter((ticket) => ticket.status === 'open').length, [tickets]);
  const customerCount = useMemo(() => new Set(tickets.map((ticket) => ticket.customer.id)).size, [tickets]);
  const visibleTickets = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return tickets.filter((ticket) => {
      if (filter === 'pending_approval' && ticket.status !== 'pending_approval') return false;
      if (!needle) return true;
      return `${ticket.subject} ${ticket.customer.name}`.toLowerCase().includes(needle);
    });
  }, [filter, search, tickets]);

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand-lockup"><span className="brand-name">Support Desk</span></div>

        <nav className="side-nav" aria-label="Main navigation">
          <button className={`nav-link${filter === 'all' ? ' active' : ''}`} aria-pressed={filter === 'all'} type="button" onClick={() => setFilter('all')}><Icon name="inbox" /><span>Case queue</span><span className="nav-count">{tickets.length}</span></button>
          <button className={`nav-link${filter === 'pending_approval' ? ' active' : ''}`} aria-pressed={filter === 'pending_approval'} type="button" onClick={() => setFilter(filter === 'pending_approval' ? 'all' : 'pending_approval')}><Icon name="clock" /><span>Approvals</span><span className="nav-count">{pendingCount}</span></button>
        </nav>

      </aside>

      <main className="main-area">
        <header className="page-header">
          <div><h1>Cases</h1></div>
        </header>

        {error && <div className="error-banner" role="alert">{error}<button type="button" onClick={() => setError('')}>Dismiss</button></div>}

        <section className="metrics-grid" aria-label="Queue summary">
          <Metric label="Open" value={openCount} />
          <Metric label="Awaiting approval" value={pendingCount} />
          <Metric label="Customers" value={customerCount} />
        </section>

        <section className="workbench" aria-label="Support cases">
          <div className="queue-panel panel">
            <div className="panel-heading queue-heading"><div><h2>Queue <span className="heading-count">{visibleTickets.length}</span></h2></div></div>
            <label className="search-box"><Icon name="search" /><input aria-label="Search cases and customers" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search cases" /></label>
            <div className="queue-tabs"><button className={filter === 'all' ? 'chosen' : ''} aria-pressed={filter === 'all'} onClick={() => setFilter('all')} type="button">All cases</button><button className={filter === 'pending_approval' ? 'chosen' : ''} aria-pressed={filter === 'pending_approval'} onClick={() => setFilter('pending_approval')} type="button">Awaiting approval</button></div>
            <div className="ticket-list" aria-live="polite">
              {queueLoading ? <div className="queue-state">Loading cases…</div> : visibleTickets.length === 0 ? <div className="queue-state">No cases match this view.</div> : visibleTickets.map((ticket) => <TicketRow key={ticket.id} ticket={ticket} selected={selectedId === ticket.id} onSelect={() => setSelectedId(ticket.id)} />)}
            </div>
            <div className="queue-footnote"><button type="button" aria-label="Refresh cases" onClick={() => setRefreshSequence((value) => value + 1)}>Refresh cases <span aria-hidden="true">↻</span></button></div>
          </div>

          <div className="detail-panel panel">
            {detailLoading ? <div className="detail-loading">Loading case details…</div> : context ? <TicketDetail
              context={context}
              operatorId={operatorId}
              actionPending={actionPending}
              onOperatorChange={setOperatorId}
              onPropose={(input) => runAction(() => createRefundProposal(context.ticket.id, input, `proposal-${crypto.randomUUID()}`))}
              onDecision={(proposalId, decision) => runAction(() => decideRefundProposal(proposalId, decision, operatorId.trim(), `decision-${crypto.randomUUID()}`))}
              onExecute={(proposalId) => runAction(() => executeRefundProposal(proposalId, `execute-${crypto.randomUUID()}`))}
            /> : <div className="detail-loading">Choose a case to review.</div>}
          </div>
        </section>
      </main>
    </div>
  );
}
