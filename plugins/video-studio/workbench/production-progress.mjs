// Progress is scoped to a single attempt; an old run file is not current evidence.
export function acceptProductionProgress(progress,job,mtimeMs){
  if(!progress||!['preparing','importing','narration','editing','exporting','reviewing'].includes(progress.stage))return false;
  if(progress.jobId && progress.jobId!==job.id)return false;
  return Number.isFinite(mtimeMs)&&mtimeMs>=Date.parse(job.startedAt);
}
export function toolFailure(item){
  const result=item?.result;
  const failed=item?.status==='failed'||result?.isError===true;
  if(!failed)return '';
  return item?.error?.message|| (typeof item?.error==='string'?item.error:'') || (result?.content||[]).filter(c=>c.type==='text').map(c=>c.text).join('\n') || '工具未返回具体失败原因';
}
export function connectionIssue(message){
  return /no browser executor|no open ChatCut editor|disconnected executor|没有连接的编辑器执行器|无连接的编辑器执行器/i.test(message);
}

export function normalizeDownloadRequest(result){
 const request=result?.downloadRequest;
 if(result?.status!=='needs_input'||!request)return null;
 if(typeof request.renderId!=='string'||!request.renderId.trim()||request.renderId.length>128)return null;
 if(typeof request.expectedFilename!=='string'||!request.expectedFilename.trim()||request.expectedFilename.length>255||/[\\/\x00-\x1f]/.test(request.expectedFilename))return null;
 if(!['review','delivery'].includes(request.purpose))return null;
 return {renderId:request.renderId,expectedFilename:request.expectedFilename,purpose:request.purpose};
}
