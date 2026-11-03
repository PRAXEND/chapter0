import {tokenUsage, usageJobs, summarizeUsage, formatTokens} from './token-usage.js';

const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'}[c]));
const statusLabels = {running:'执行中', completed:'已完成', blocked:'需处理', failed:'失败', cancelled:'已停止', interrupted:'已中断', needs_input:'等待补充', cancelling:'正在停止'};
const running = job => ['running', 'cancelling'].includes(job?.status);
const usageRows = usage => `<dl class="token-breakdown"><div><dt>输入</dt><dd>${formatTokens(usage.input)}</dd></div><div class="token-subset"><dt>其中缓存输入</dt><dd>${formatTokens(usage.cached)}</dd></div><div><dt>输出</dt><dd>${formatTokens(usage.output)}</dd></div>${usage.reasoning !== undefined && usage.reasoning !== null ? `<div class="token-subset"><dt>其中推理输出</dt><dd>${formatTokens(usage.reasoning)}</dd></div>` : ''}</dl>`;
const jobTotal = job => {
  const usage = tokenUsage(job.usage);
  return usage.total !== null ? formatTokens(usage.total) : running(job) ? '结束后显示' : '未完整上报';
};

export function renderTokenUsage(project, currentJob, historyOpen = false) {
  const jobs = usageJobs(project), summary = summarizeUsage(jobs);
  const missing = [summary.pending ? `${summary.pending} 次执行中` : '', summary.missing ? `${summary.missing} 次用量未完整上报` : ''].filter(Boolean);
  return `<h3>Token 用量</h3>${currentJob ? `<div class="token-current"><span>本次任务 · ${esc(currentJob.label || '任务')}</span><strong>${jobTotal(currentJob)}</strong>${usageRows(tokenUsage(currentJob.usage))}${running(currentJob) && tokenUsage(currentJob.usage).total === null ? '<p class="token-note">执行中，任务结束后显示实际用量。</p>' : ''}</div>` : '<p class="token-note">执行任务后显示实际用量。</p>'}<div class="token-project-total"><span>本项目${missing.length ? '已记录' : '累计'}</span><strong>${formatTokens(summary.total)}</strong></div>${jobs.length ? `<p class="token-note">${summary.reported} / ${jobs.length} 次任务已返回完整用量${missing.length ? '；' + missing.join('，') : ''}。包含搜索、采集、文案、制作及重试。</p><details class="token-history" ${historyOpen ? 'open' : ''}><summary>查看每次任务（${jobs.length}）</summary><ol>${jobs.map(job => `<li><div><span>${esc(job.label || '任务')} · ${esc(statusLabels[job.status] || job.status || '')}</span><strong>${jobTotal(job)}</strong></div><time>${esc(job.startedAt ? new Date(job.startedAt).toLocaleString('zh-CN', {hour12:false}) : '日期未记录')}</time>${usageRows(tokenUsage(job.usage))}</li>`).join('')}</ol></details>` : ''}<p class="token-note">总数 = 输入 + 输出，缓存和推理不重复累加。仅统计工作台任务，ChatCut 服务额度另计。</p>`;
}
