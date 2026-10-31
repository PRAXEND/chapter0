const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const labels={missing:'缺失',lfs_pointer:'尚未下载（LFS 指针）',hash_mismatch:'文件内容变化',unsafe:'不安全路径',invalid_index:'索引异常',unreadable:'无法读取'};
export function renderDependencyCheck(check){
  const state=check.ok?'ready':check.required===false?'optional':'needs-fix';
  const optional=check.required===false?(check.id==='git_lfs'?'补齐素材时使用':'选用此风格时需要'):'';
  const issues=check.issues||[];
  return `<div class="runtime-check ${state}"><strong>${check.ok?'✓':check.required===false?'○':'!'} ${escape(check.label)}</strong>${optional?`<small>${optional}</small>`:''}<span>${escape(check.message)}</span>${!check.ok?`<small>${escape(check.remedy)}</small>`:''}${check.packRoot?`<details><summary>素材位置${issues.length?'与待处理文件':''}</summary><code>${escape(check.packRoot)}</code>${issues.slice(0,20).map(issue=>`<p>${escape(labels[issue.status]||issue.status)} · ${escape(issue.path)}${issue.detail?`：${escape(issue.detail)}`:''}</p>`).join('')}${issues.length>20?`<p>另有 ${issues.length-20} 项，完整列表可通过命令行前检查看。</p>`:''}</details>`:''}</div>`;
}
