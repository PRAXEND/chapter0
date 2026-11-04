const zone='Asia/Singapore',dayMs=86400000;
export function dateKey(value){
  if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}(?:$|T)/.test(value)||!Number.isFinite(Date.parse(value)))return '';
  if(new Date(value.slice(0,10)+'T00:00:00Z').toISOString().slice(0,10)!==value.slice(0,10))return '';
  const parts=new Intl.DateTimeFormat('en-CA',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date(value));
  return ['year','month','day'].map(k=>parts.find(p=>p.type===k).value).join('-');
}
export function publicationDay(source){return dateKey(source.publishedAt);}
export function ageInDays(value,now=Date.now()){const day=dateKey(value),today=dateKey(new Date(now).toISOString());return day?Math.round((Date.parse(today)-Date.parse(day))/dayMs):null;}
export function inDateWindow(source,window,now=Date.now()){
  const age=ageInDays(source.publishedAt,now);
  if(window==='all')return true;if(window==='unknown')return age===null;
  return age!==null&&age>=0&&age<Number(window);
}
export function sortMaterials(items){return [...items].sort((a,b)=>publicationDay(b).localeCompare(publicationDay(a))||String(b.publishedAt||'').localeCompare(String(a.publishedAt||''))||String(b.lastSeenAt||b.cachedAt||'').localeCompare(String(a.lastSeenAt||a.cachedAt||'')));}
export function dayLabel(value,now=Date.now()){const day=dateKey(value);if(!day)return '发布日期待核实';const age=ageInDays(value,now);return day+(age===0?' · 今天':age===1?' · 昨天':age>1&&age<7?` · ${age} 天前`:'');}
