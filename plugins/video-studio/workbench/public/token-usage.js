const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const sum = values => {
  const known = values.filter(value => value !== null);
  if (!known.length) return null;
  return count(known.reduce((total, value) => total + value, 0));
};

export function tokenUsage(raw) {
  const input = count(raw?.input_tokens), output = count(raw?.output_tokens);
  const cached = count(raw?.cached_input_tokens ?? raw?.input_tokens_details?.cached_tokens);
  const reasoning = count(raw?.reasoning_output_tokens ?? raw?.output_tokens_details?.reasoning_tokens);
  return {
    input, output,
    cached: input !== null && cached !== null && cached <= input ? cached : null,
    reasoning: output !== null && reasoning !== null && reasoning <= output ? reasoning : null,
    total: input !== null && output !== null ? sum([input, output]) : null
  };
}

// A compact ledger survives the detailed event log's 50-job retention limit.
export function usageJobs(project) {
  const byId = new Map();
  for (const job of [...(project.tokenUsageJobs || []), ...(project.jobs || [])]) {
    if (!job?.id) continue;
    const previous = byId.get(job.id);
    byId.set(job.id, {
      id: job.id, action: job.action, label: job.label, status: job.status,
      startedAt: job.startedAt, completedAt: job.completedAt,
      usage: job.usage ?? previous?.usage ?? null
    });
  }
  return [...byId.values()].sort((a, b) => String(b.startedAt || '').localeCompare(String(a.startedAt || '')));
}

export function rememberUsage(project) {
  project.tokenUsageJobs = usageJobs(project);
}

export function summarizeUsage(jobs) {
  const entries = jobs.map(job => ({job, usage: tokenUsage(job.usage)}));
  return {
    input: sum(entries.map(e => e.usage.input)),
    output: sum(entries.map(e => e.usage.output)),
    cached: sum(entries.map(e => e.usage.cached)),
    // Cache and reasoning are subsets, never additional tokens.
    total: sum(entries.flatMap(e => [e.usage.input, e.usage.output])),
    reported: entries.filter(e => e.usage.total !== null).length,
    pending: entries.filter(e => e.usage.total === null && ['running', 'cancelling'].includes(e.job.status)).length,
    missing: entries.filter(e => e.usage.total === null && !['running', 'cancelling'].includes(e.job.status)).length
  };
}

export const formatTokens = value => value === null ? '未上报' : value.toLocaleString('zh-CN');
