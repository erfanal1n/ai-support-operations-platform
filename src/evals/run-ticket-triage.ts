import { TicketTriageAgent } from '../ai/ticket-triage.js';
import { env } from '../config/env.js';
import { MemoryStore } from '../data/db.js';
import { createPolicySearch } from '../support/policy-retrieval.js';
import { evaluateTicketTriage } from './evaluate-ticket-triage.js';
import { createEvalTicket, ticketTriageCases } from './ticket-triage-cases.js';

if (env.AI_TRIAGE_MODE !== 'openai' || !env.OPENAI_API_KEY) {
  process.stderr.write('Set AI_TRIAGE_MODE=openai and OPENAI_API_KEY to run triage evals.\n');
  process.exitCode = 1;
} else {
  const store = new MemoryStore();
  for (const scenario of ticketTriageCases) store.tickets.set(`eval_${scenario.id}`, createEvalTicket(scenario));

  const agent = new TicketTriageAgent(
    env.OPENAI_API_KEY,
    env.OPENAI_TRIAGE_MODEL,
    store,
    createPolicySearch(env)
  );
  const results = await evaluateTicketTriage(store, agent, ticketTriageCases);
  const passed = results.filter(({ passed: ok }) => ok).length;
  const percentage = (count: number, total: number) => total === 0 ? null : count / total;
  const byId = new Map(ticketTriageCases.map((scenario) => [scenario.id, scenario]));
  const policyCases = results.filter(({ id }) => byId.get(id)?.expectedPolicyId);
  const invoiceCases = results.filter(({ id }) => (byId.get(id)?.expectedInvoiceIds?.length ?? 0) > 0);
  const injectionCase = results.find(({ id }) => id === 'ticket-injection');
  const latencies = results.map(({ latencyMs }) => latencyMs).sort((left, right) => left - right);
  const percentile = (value: number) => latencies.length
    ? latencies[Math.max(0, Math.ceil(value * latencies.length) - 1)]!
    : null;
  const measuredUsage = results.flatMap(({ tokenUsage }) => tokenUsage ? [tokenUsage] : []);
  const sum = (key: 'inputTokens' | 'outputTokens' | 'totalTokens') => measuredUsage
    .reduce((total, usage) => total + usage[key], 0);
  const report = {
    model: env.OPENAI_TRIAGE_MODEL,
    retrievalMode: env.POLICY_RETRIEVAL_MODE,
    total: results.length,
    passed,
    actionAccuracy: percentage(results.filter(({ actionCorrect }) => actionCorrect).length, results.length),
    policyCitationRate: percentage(policyCases.filter(({ policyCited }) => policyCited).length, policyCases.length),
    invoiceCitationRate: percentage(invoiceCases.filter(({ invoicesCited }) => invoicesCited).length, invoiceCases.length),
    injectionPassed: injectionCase?.passed ?? false,
    statePreserved: results.every(({ stateUnchanged }) => stateUnchanged),
    latencyMs: {
      sampleCount: latencies.length,
      p50: percentile(0.5),
      p95: percentile(0.95),
    },
    modelUsage: {
      modelCalls: results.reduce((total, result) => total + (result.modelCalls ?? 0), 0),
      measuredCases: measuredUsage.length,
      inputTokens: sum('inputTokens'),
      outputTokens: sum('outputTokens'),
      totalTokens: sum('totalTokens'),
      averageTokensPerMeasuredCase: measuredUsage.length
        ? Math.round(sum('totalTokens') / measuredUsage.length)
        : null,
    },
    cases: results,
  };

  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (passed !== results.length) process.exitCode = 1;
}
