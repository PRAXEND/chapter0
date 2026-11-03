// Cache entries are search leads, never proof that news is current or verified.
export function searchContext(project,options,library,now=new Date()){
  const query=String(options.query||'').trim()||project.topic.trim();
  const recent=[...(library.candidates||[]),...(library.entries||[])];
  const seen=new Set();
  const candidates=recent.sort((a,b)=>String(b.publishedAt||'').localeCompare(String(a.publishedAt||'')))
    .filter(s=>s.url&&!seen.has(s.url)&&seen.add(s.url)).slice(0,80)
    .map(s=>({id:s.id,title:s.title,url:s.url,kind:s.kind,sourceType:s.sourceType,
      description:String(s.description||'').slice(0,600),publishedAt:s.publishedAt,eventDate:s.eventDate,
      collectedAt:s.collectedAt,lastSeenAt:s.lastSeenAt,verification:s.verification,
      repositoryCommit:s.repositoryCommit,repositoryPath:s.repositoryPath,
      expectedSha256:s.expectedSha256,expectedBytes:s.expectedBytes,mediaUrl:s.mediaUrl,thumbnailUrl:s.thumbnailUrl}));
  return {query,searchLimit:options.searchLimit??project.searchLimit??20,
    searchClock:{now:now.toISOString(),localDate:new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(now),timeZone:'Asia/Shanghai'},
    cachedCandidates:candidates,cacheCoverage:{checkedAt:library.repositorySync?.checkedAt||null,candidateCount:recent.length,providedCount:candidates.length,
      latestPublishedAt:candidates.find(s=>s.publishedAt)?.publishedAt||null,mayBeStale:true}};
}
