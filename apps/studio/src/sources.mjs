import dns from 'node:dns/promises';
import https from 'node:https';
import { BlockList, isIP } from 'node:net';
import { createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const agent = 'VideoStudio/1.0 (local video editor; source attribution retained)';
const limit = 64 * 1024 * 1024;
const blocked = new BlockList();
for (const [address, bits] of [['0.0.0.0',8],['10.0.0.0',8],['100.64.0.0',10],['127.0.0.0',8],['169.254.0.0',16],
  ['172.16.0.0',12],['192.0.0.0',24],['192.0.2.0',24],['192.168.0.0',16],['198.18.0.0',15],['198.51.100.0',24],
  ['203.0.113.0',24],['224.0.0.0',4],['240.0.0.0',4]]) blocked.addSubnet(address, bits, 'ipv4');

function publicAddress(address) {
  if (isIP(address) === 4) return !blocked.check(address, 'ipv4');
  // Only global unicast IPv6. Exclude documentation, embedding and tunnelling prefixes.
  return isIP(address) === 6 && /^[23]/i.test(address) && !/^(2001:(db8|0):|2002:)/i.test(address);
}
async function publicRequest(input, signal, redirects = 0) {
  const url = new URL(input);
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) throw new Error('素材地址必须是公开 HTTPS 直链。');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const records = await dns.lookup(host, { all: true });
  if (!records.length || records.some(record => !publicAddress(record.address))) throw new Error('素材地址不属于公开网络。');
  const res = await new Promise((resolve, reject) => {
    const req = https.get(url, { signal, headers: { 'user-agent': agent, accept: 'image/*,video/*,audio/*' },
      // Use the addresses that were just checked for this connection as well.
      lookup: (_host, options, callback) => options.all ? callback(null, records) : callback(null, records[0].address, records[0].family) }, resolve);
    req.on('error', reject);
  });
  if ([301,302,303,307,308].includes(res.statusCode)) {
    res.resume(); if (redirects >= 4 || !res.headers.location) throw new Error('素材重定向过多。');
    return publicRequest(new URL(res.headers.location, url), signal, redirects + 1);
  }
  if (res.statusCode !== 200 || Number(res.headers['content-length']) > limit) { res.destroy(); throw new Error('素材下载失败或超过 64 MB。'); }
  return res;
}

const mimeExtensions = { 'image/jpeg':'.jpg','image/png':'.png','image/webp':'.webp','image/gif':'.gif',
  'video/mp4':'.mp4','video/webm':'.webm','video/quicktime':'.mov','video/ogg':'.ogv','audio/mpeg':'.mp3',
  'audio/wav':'.wav','audio/x-wav':'.wav','audio/mp4':'.m4a','audio/ogg':'.ogg' };
export async function importSource(store, projectId, candidate, { signal } = {}) {
  const p = await store.get(projectId);
  const existing = p.assets.find(a => a.source?.downloadUrl === candidate.downloadUrl);
  if (existing) return existing;
  const paths = await store.paths(projectId);
  await mkdir(paths.cache, { recursive: true });
  const temp = await mkdtemp(path.join(paths.cache, 'source-'));
  try {
    const downloadSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000);
    const res = await publicRequest(candidate.downloadUrl, downloadSignal);
    const ext = mimeExtensions[String(res.headers['content-type']).split(';')[0].toLowerCase()];
    if (!ext) { res.destroy(); throw new Error('来源未返回受支持的媒体格式。'); }
    const file = path.join(temp, candidate.title.replace(/[^\p{L}\p{N} _-]/gu, ' ').slice(0,65).trim().replace(/^\.+/,'') + ext);
    let bytes = 0;
    const check = new Transform({ transform(chunk, _encoding, callback) {
      bytes += chunk.length; callback(bytes > limit ? new Error('素材超过 64 MB。') : null, chunk);
    } });
    await pipeline(res, check, createWriteStream(file, { flags: 'wx' }), { signal: downloadSignal });
    return await store.addAsset(projectId, file, { ...candidate, acquiredAt: new Date().toISOString() });
  } finally { await rm(temp, { recursive: true, force: true }); }
}

function clean(value) {
  return String(value || '').replace(/<[^>]*>/g, ' ').replace(/&amp;/g,'&').replace(/&#39;/g,"'").replace(/&quot;/g,'"').replace(/\s+/g,' ').trim().slice(0,1600);
}
async function json(url, signal) {
  const local = AbortSignal.timeout(6500); const s = signal ? AbortSignal.any([signal, local]) : local;
  const result = await fetch(url, { headers: { 'user-agent': agent, accept: 'application/json' }, signal: s });
  if (!result.ok) throw new Error('来源服务响应 ' + result.status);
  return result.json();
}
async function commons(query, signal) {
  const url = new URL('https://commons.wikimedia.org/w/api.php');
  url.search = new URLSearchParams({ action:'query', generator:'search',gsrsearch:query,gsrnamespace:'6',gsrlimit:'12',
    prop:'imageinfo',iiprop:'url|extmetadata|size|mime',iiurlwidth:'1280',format:'json',formatversion:'2' });
  const data = await json(url, signal);
  return (data.query?.pages || []).flatMap(page => {
    const info = page.imageinfo?.[0]; const meta = info?.extmetadata || {};
    const license = clean(meta.LicenseShortName?.value);
    if (!info || !/^(cc0|cc by(?:-sa)?(?: |$)|public domain)/i.test(license) || /[- ](?:NC|ND)\b/i.test(license)) return [];
    if (!['image/jpeg','image/png','image/webp','video/webm','video/mp4','video/ogg'].includes(info.mime)) return [];
    const downloadUrl = info.mime.startsWith('image/') && info.size > 4_000_000 ? info.thumburl : info.url;
    if (!downloadUrl || new URL(downloadUrl).hostname !== 'upload.wikimedia.org') return [];
    return [{ provider:'Wikimedia Commons', title:clean(page.title.replace(/^File:/,'')), url:info.descriptionurl,
      downloadUrl, credit:clean(meta.Artist?.value) || 'Wikimedia Commons', license, licenseUrl:clean(meta.LicenseUrl?.value),
      statement:clean(meta.ImageDescription?.value), date:clean(meta.DateTimeOriginal?.value) }];
  });
}
async function nasa(query, signal) {
  const url = new URL('https://images-api.nasa.gov/search');
  url.search = new URLSearchParams({ q:query,media_type:'image',page_size:'8' });
  const data = await json(url, signal);
  return (data.collection?.items || []).flatMap(item => {
    const record = item.data?.[0];
    const downloadUrl = item.links?.find(l => l.rel === 'preview' || l.render === 'image')?.href;
    if (!record?.nasa_id || !downloadUrl || new URL(downloadUrl).hostname !== 'images-assets.nasa.gov' || !record.center) return [];
    const attribution = [record.photographer, record.secondary_creator, record.description].filter(Boolean).join(' ');
    if (/(copyright|©|getty|reuters|associated press|used with permission|ESA\/|ESA,|SpaceX|Roscosmos|courtesy of)/i.test(attribution)) return [];
    return [{ provider:'NASA Image and Video Library', title:clean(record.title), url:'https://images.nasa.gov/details/' + encodeURIComponent(record.nasa_id),
      downloadUrl, credit:['NASA', record.center, record.photographer].filter(Boolean).join(' / '), license:'NASA media usage guidelines',
      licenseUrl:'https://www.nasa.gov/nasa-brand-center/images-and-media/', statement:clean(record.description), date:record.date_created }];
  });
}
async function openverse(query,signal) {
  const url=new URL('https://api.openverse.org/v1/images/');
  url.search=new URLSearchParams({q:query,license:'cc0,by,by-sa,pdm',page_size:'8'});
  const data=await json(url,signal);
  return (data.results||[]).filter(r=>['cc0','by','by-sa','pdm'].includes(r.license) && r.foreign_landing_url?.startsWith('https://') && r.url?.startsWith('https://')).map(r=>({
    provider:'Openverse / '+clean(r.source),title:clean(r.title),url:r.foreign_landing_url,downloadUrl:r.url,
    license:'CC '+r.license.toUpperCase()+' '+clean(r.license_version),licenseUrl:clean(r.license_url),
    credit:clean(r.creator)||clean(r.attribution),statement:clean(r.title),date:clean(r.created_on)}));
}

// These references describe claims. An illustrative media asset keeps its own separate credit.
export async function searchFacts(query,{signal}={}) {
  const term=String(query||'').trim().slice(0,200);
  if(!term)return [];
  const lang=/[\u3400-\u9fff]/.test(term)?'zh':'en';
  const wiki=new URL('https://'+lang+'.wikipedia.org/w/api.php');
  wiki.search=new URLSearchParams({action:'query',generator:'search',gsrsearch:term,gsrlimit:'4',prop:'extracts|info',inprop:'url',
    exintro:'1',explaintext:'1',exsentences:'4',format:'json',formatversion:'2'});
  const crossref=new URL('https://api.crossref.org/works');
  crossref.search=new URLSearchParams({'query.bibliographic':term,rows:'5',select:'DOI,title,abstract,published,publisher'});
  const [papers,encyclopedia]=await Promise.allSettled([json(crossref,signal),json(wiki,signal)]);
  signal?.throwIfAborted();
  const a=papers.status==='fulfilled'?(papers.value.message?.items||[]).map(p=>({url:'https://doi.org/'+p.DOI,title:clean(p.title?.[0]),
    excerpt:clean(p.abstract||p.title?.[0]),date:p.published?.['date-parts']?.[0]?.join('-')||'',publisher:clean(p.publisher),type:'paper'})):[];
  const b=encyclopedia.status==='fulfilled'?(encyclopedia.value.query?.pages||[]).map(p=>({url:p.fullurl,title:clean(p.title),
    excerpt:clean(p.extract),publisher:'Wikipedia',type:'encyclopedia'})):[];
  return [...b,...a].filter(x=>x.url&&x.excerpt);
}
export async function searchSources(query, { signal } = {}) {
  const term = String(query || '').trim().slice(0,200);
  if (!term) return [];
  // NASA only serves space/aviation subjects; a generic phrase would yield false evidence.
  const space = /太空|月球|登月|火星|航天|天文|宇航|卫星|空间站|望远镜|\b(nasa|apollo|moon|mars|space|orbital|telescope|astronaut|satellite|lunar)\b/i.test(term);
  const search = [commons(term, signal),openverse(term,signal)];
  if (space) search.push(nasa(term.replace(/月球/g,' Moon ').replace(/登月/g,' Apollo ').replace(/火星/g,' Mars ')
    .replace(/国际空间站/g,' International Space Station ').replace(/太空/g,' space ').replace(/航天/g,' spacecraft ').replace(/[\u3400-\u9fff]/g,' ').trim() || 'NASA', signal));
  const results = await Promise.allSettled(search);
  signal?.throwIfAborted();
  return results.flatMap(result => result.status === 'fulfilled' ? result.value : []).slice(0,12);
}

export function directSources(project) {
  const list = Array.isArray(project.settings?.sourceUrls) ? project.settings.sourceUrls : [];
  return list.slice(0,16).map(entry => typeof entry === 'string' ? { url:entry } : entry).filter(entry => entry?.url).map(entry => ({
    provider:'用户提供', title:clean(entry.title || decodeURIComponent(new URL(entry.url).pathname.split('/').pop() || '素材')),
    url:entry.url, downloadUrl:entry.url, credit:clean(entry.credit || '用户提供'), license:clean(entry.license || '使用范围待核'),
    statement:clean(entry.statement || ''), date:clean(entry.date || '') }));
}
