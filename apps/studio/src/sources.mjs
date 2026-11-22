import dns from 'node:dns/promises';
import https from 'node:https';
import { BlockList, isIP } from 'node:net';
import { createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { probeMedia } from './media.mjs';
import { publisherCatalogs, searchPublisherCatalog } from './publisher-catalogs.mjs';

const agent = 'VideoStudio/1.0 (local video editor; source attribution retained)';
const limit = 64 * 1024 * 1024;
const videoLimit = 256 * 1024 * 1024;
const catalogHosts = new Set([
  'commons.wikimedia.org',
  'upload.wikimedia.org',
  'api.openverse.org',
  'images-api.nasa.gov',
  'images-assets.nasa.gov',
  'www.nasa.gov',
  'apollojournals.org',
  'science.nasa.gov',
  'api.crossref.org',
  'en.wikipedia.org',
  'zh.wikipedia.org',
]);
// Use the configured network proxy for known catalog services, including their media hosts.
// Unknown user-provided hosts continue to use the public IP resolved below.
const catalogAgent = new https.Agent({ proxyEnv: process.env });
const blocked = new BlockList();
for (const [address, bits] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
])
  blocked.addSubnet(address, bits, 'ipv4');

function publicAddress(address) {
  if (isIP(address) === 4) return !blocked.check(address, 'ipv4');
  // Only global unicast IPv6. Exclude documentation, embedding and tunnelling prefixes.
  return isIP(address) === 6 && /^[23]/i.test(address) && !/^(2001:(db8|0):|2002:)/i.test(address);
}
async function publicRequest(
  input,
  signal,
  redirects = 0,
  { maxBytes = limit, accept = 'image/*,video/*,audio/*' } = {}
) {
  const url = new URL(input);
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443'))
    throw new Error('素材地址必须是公开 HTTPS 直链。');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const records = await dns.lookup(host, { all: true });
  if (!records.length || records.some((record) => !publicAddress(record.address)))
    throw new Error('素材地址不属于公开网络。');
  const res = await new Promise((resolve, reject) => {
    const req = https.get(
      url,
      {
        signal,
        agent: catalogHosts.has(host) ? catalogAgent : undefined,
        headers: { 'user-agent': agent, accept },
        // Use the addresses that were just checked for this connection as well.
        lookup: (_host, options, callback) =>
          options.all ? callback(null, records) : callback(null, records[0].address, records[0].family),
      },
      resolve
    );
    req.on('error', reject);
  });
  if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
    res.resume();
    if (redirects >= 4 || !res.headers.location) throw new Error('素材重定向过多。');
    return publicRequest(new URL(res.headers.location, url), signal, redirects + 1, { maxBytes, accept });
  }
  if (res.statusCode !== 200 || Number(res.headers['content-length']) > maxBytes) {
    res.destroy();
    const retry = res.headers['retry-after'];
    const reason =
      res.statusCode === 200
        ? '文件超过 ' + Math.floor(maxBytes / 1048576) + ' MiB。'
        : '来源响应 HTTP ' + res.statusCode + (retry ? '（Retry-After ' + retry + '）' : '');
    throw Object.assign(new Error(reason), { status: res.statusCode, retryAfter: retry });
  }
  return res;
}

const mimeExtensions = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'video/mp4': '.mp4',
  'video/webm': '.webm',
  'video/quicktime': '.mov',
  'video/ogg': '.ogv',
  'video/mpeg': '.mpg',
  'audio/mpeg': '.mp3',
  'audio/wav': '.wav',
  'audio/x-wav': '.wav',
  'audio/mp4': '.m4a',
  'audio/ogg': '.ogg',
};
const suffixKind = (file) => {
  const suffix = path.extname(new URL(file).pathname).toLowerCase();
  if (['.mp4', '.webm', '.mov', '.ogv', '.mpg', '.mpeg', '.m4v'].includes(suffix)) return 'video';
  if (['.jpg', '.jpeg', '.png', '.webp', '.gif'].includes(suffix)) return 'image';
  if (['.wav', '.mp3', '.m4a', '.ogg'].includes(suffix)) return 'audio';
  return undefined;
};
async function download(url, candidate, temp, signal, maxBytes, openMedia, probe) {
  const res = await openMedia(url, signal, 0, { maxBytes });
  const type = String(res.headers['content-type']).split(';')[0].toLowerCase();
  const suffix = path.extname(new URL(url).pathname).toLowerCase();
  const ext =
    mimeExtensions[type] ||
    (type === 'application/octet-stream' && suffixKind(url) ? suffix : null) ||
    (type === 'application/ogg' && ['.ogv', '.ogg'].includes(suffix) ? suffix : null);
  if (!ext) {
    res.destroy();
    throw new Error('来源未返回受支持的媒体格式。');
  }
  const file = path.join(
    temp,
    String(candidate.title || '素材')
      .replace(/[^\p{L}\p{N} _-]/gu, ' ')
      .slice(0, 65)
      .trim()
      .replace(/^\.+/, '') + ext
  );
  let bytes = 0;
  const check = new Transform({
    transform(chunk, _encoding, callback) {
      bytes += chunk.length;
      callback(
        bytes > maxBytes ? new Error('素材超过 ' + Math.floor(maxBytes / 1048576) + ' MiB。') : null,
        chunk
      );
    },
  });
  try {
    await pipeline(res, check, createWriteStream(file, { flags: 'wx' }), { signal });
    const actual = await probe(file, { signal });
    if (candidate.kind && candidate.kind !== actual.kind)
      throw new Error('候选标为 ' + candidate.kind + '，实际文件是 ' + actual.kind + '。');
    return { file, kind: actual.kind };
  } catch (error) {
    await rm(file, { force: true });
    throw error;
  }
}
export async function importSource(
  store,
  projectId,
  candidate,
  { signal, openMedia = publicRequest, probe = probeMedia } = {}
) {
  const p = await store.get(projectId);
  const existing = p.assets.find(
    (a) =>
      a.source?.downloadUrl === candidate.downloadUrl || a.source?.requestedDownloadUrl === candidate.downloadUrl
  );
  if (existing) return existing;
  const paths = await store.paths(projectId);
  await mkdir(paths.cache, { recursive: true });
  const temp = await mkdtemp(path.join(paths.cache, 'source-'));
  try {
    const video = (candidate.kind || suffixKind(candidate.downloadUrl)) === 'video';
    const timeout = AbortSignal.timeout(video ? 180_000 : 30_000);
    const deadline = signal ? AbortSignal.any([signal, timeout]) : timeout;
    const alternatives = [...new Set([candidate.downloadUrl, ...(candidate.alternateUrls || [])])];
    let lastError;
    for (const url of alternatives) {
      let saved;
      try {
        saved = await download(url, candidate, temp, deadline, video ? videoLimit : limit, openMedia, probe);
      } catch (error) {
        deadline.throwIfAborted();
        if (error.status === 429 || error.retryAfter) throw error;
        lastError = error;
        continue;
      }
      const { alternateUrls, ...source } = candidate;
      return await store.addAsset(projectId, saved.file, {
        ...source,
        kind: saved.kind,
        requestedDownloadUrl: candidate.downloadUrl,
        downloadUrl: url,
        acquiredAt: new Date().toISOString(),
      });
    }
    throw lastError || new Error('没有可获取的媒体版本。');
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

function clean(value) {
  return String(value || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 1600);
}

function briefUrls(project) {
  const matches = String(project.brief || '').match(/https:\/\/[^\s<>"，。！？）\])]+/gu) || [];
  return [
    ...new Set(
      matches.flatMap((value) => {
        try {
          return [new URL(value.replace(/[.,;]+$/g, '')).href];
        } catch {
          return [];
        }
      })
    ),
  ].slice(0, 12);
}
const isMediaUrl = (url) => Boolean(suffixKind(url));
export async function readBriefSources(project, { signal } = {}) {
  const provided = Array.isArray(project.settings?.factUrls) ? project.settings.factUrls : [];
  const urls = [...new Set([...provided, ...briefUrls(project).filter((url) => !isMediaUrl(url))])];
  const known = new Map((project.factSources || []).map((f) => [f.url, f]));
  for (const url of urls.slice(0, 8)) {
    if (known.has(url)) continue;
    try {
      const s = signal ? AbortSignal.any([signal, AbortSignal.timeout(9000)]) : AbortSignal.timeout(9000);
      const maxBytes = 1024 * 1024;
      const res = await publicRequest(url, s, 0, { accept: 'text/html,text/plain', maxBytes });
      if (!/^text\/(html|plain)/i.test(res.headers['content-type'] || '')) {
        res.destroy();
        continue;
      }
      const chunks = [];
      let bytes = 0;
      for await (const part of res) {
        bytes += part.length;
        if (bytes > maxBytes) {
          res.destroy();
          throw Error('网页超出大小限制');
        }
        chunks.push(part);
      }
      const raw = Buffer.concat(chunks)
        .toString('utf8')
        .replace(/<(script|style|nav|footer)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ');
      const title = clean(raw.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || new URL(url).hostname);
      const paragraphs = [...raw.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)]
        .map((m) => clean(m[1]))
        .filter((s) => s.length >= 24);
      const excerpt = clean(paragraphs.slice(0, 6).join(' ') || raw);
      const date =
        raw.match(/<meta[^>]*property=["']article:published_time["'][^>]*content=["']([^"']+)/i)?.[1] || '';
      if (excerpt)
        known.set(url, { url, title, excerpt, date, publisher: new URL(url).hostname, type: 'user-source' });
    } catch {
      signal?.throwIfAborted();
    }
  }
  return [...known.values()];
}
async function catalogBody(url, signal, accept) {
  const timeout = AbortSignal.timeout(10_000);
  const deadline = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const maxBytes = 3 * 1024 * 1024;
  const res = await publicRequest(url, deadline, 0, { accept, maxBytes });
  if (accept === 'text/html' && !/^text\/html\b/i.test(res.headers['content-type'] || '')) {
    res.destroy();
    throw Error('目录没有返回 HTML。');
  }
  const parts = [];
  let bytes = 0;
  for await (const part of res) {
    bytes += part.length;
    if (bytes > maxBytes) {
      res.destroy();
      throw new Error('来源的目录响应过大。');
    }
    parts.push(part);
  }
  return Buffer.concat(parts).toString('utf8');
}
async function json(url, signal) {
  return JSON.parse(await catalogBody(url, signal, 'application/json'));
}
const directoryCache = new Map();
async function publisherHtml(url, signal) {
  signal?.throwIfAborted();
  const cached = directoryCache.get(url);
  if (cached && cached.until > Date.now()) return cached.html;
  const html = await catalogBody(url, signal, 'text/html');
  if (directoryCache.size >= 32) directoryCache.delete(directoryCache.keys().next().value);
  directoryCache.set(url, { html, until: Date.now() + 3_600_000 });
  return html;
}
function hosted(file, hostname) {
  try {
    const url = new URL(file);
    if (
      !['https:', 'http:'].includes(url.protocol) ||
      url.hostname !== hostname ||
      url.username ||
      url.password ||
      url.port
    )
      return null;
    url.protocol = 'https:';
    for (const key of [...url.searchParams.keys()]) if (key.startsWith('utm_')) url.searchParams.delete(key);
    return url.href;
  } catch {
    return null;
  }
}
function licenseAllowed(license) {
  return /^(cc0|cc by(?:-sa)?(?: |$)|public domain)/i.test(license) && !/[- ](?:NC|ND)\b/i.test(license);
}
async function commons(query, kind, readJson, signal) {
  const video = kind === 'video',
    prefix = video ? 'vi' : 'ii';
  const url = new URL('https://commons.wikimedia.org/w/api.php');
  url.search = new URLSearchParams({
    action: 'query',
    generator: 'search',
    gsrsearch: query + ' filetype:' + (video ? 'video' : 'bitmap'),
    gsrnamespace: '6',
    gsrlimit: '6',
    prop: video ? 'videoinfo' : 'imageinfo',
    format: 'json',
    formatversion: '2',
    [prefix + 'prop']: 'url|extmetadata|size|mime' + (video ? '|derivatives' : ''),
    [prefix + 'extmetadatalanguage']: 'en',
    ...(video ? {} : { iiurlwidth: '1280' }),
  });
  const data = await readJson(url, signal);
  return [...(data.query?.pages || [])]
    .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
    .flatMap((page) => {
      const info = (video ? page.videoinfo : page.imageinfo)?.[0],
        meta = info?.extmetadata || {};
      const license = clean(meta.LicenseShortName?.value);
      if (!info || !licenseAllowed(license)) return [];
      const original = hosted(info.url, 'upload.wikimedia.org');
      let urls;
      if (video) {
        if (!/^(video\/|application\/ogg)/.test(info.mime || '')) return [];
        const derivatives = (info.derivatives || [])
          .filter((d) => String(d.type).startsWith('video/'))
          .sort(
            (a, b) => Math.abs(Math.log2((a.width || 480) / 960)) - Math.abs(Math.log2((b.width || 480) / 960))
          )
          .map((d) => hosted(d.src, 'upload.wikimedia.org'));
        urls = [Number(info.size) > 0 && info.size <= videoLimit ? original : null, ...derivatives];
      } else {
        if (!['image/jpeg', 'image/png', 'image/webp'].includes(info.mime)) return [];
        urls = [info.size > 4_000_000 ? hosted(info.thumburl, 'upload.wikimedia.org') : null, original];
      }
      urls = [...new Set(urls.filter(Boolean))];
      if (!urls.length) return [];
      return [
        {
          provider: 'Wikimedia Commons',
          kind,
          title: clean(page.title.replace(/^File:/, '')),
          url: info.descriptionurl,
          downloadUrl: urls[0],
          alternateUrls: urls.slice(1, 5),
          originalUrl: original,
          credit: clean(meta.Artist?.value) || 'Wikimedia Commons',
          license,
          licenseUrl: clean(meta.LicenseUrl?.value),
          statement: clean(meta.ImageDescription?.value),
          date: clean(meta.DateTimeOriginal?.value),
          evidenceLevel: 'catalog-description',
        },
      ];
    });
}
function nasaQuality(file) {
  const tiers = ['medium', 'small', 'orig', 'large', 'mobile', 'preview'];
  const match = new URL(file).pathname.match(/~([^/.]+)\.[^/.]+$/);
  const index = tiers.indexOf(match?.[1]);
  return index < 0 ? tiers.length : index;
}
async function nasa(query, kind, readJson, signal) {
  const url = new URL('https://images-api.nasa.gov/search');
  url.search = new URLSearchParams({ q: query, media_type: kind, page_size: '6' });
  const data = await readJson(url, signal);
  const jobs = (data.collection?.items || []).map(async (item) => {
    const record = item.data?.[0];
    if (!record?.nasa_id || record.media_type !== kind || !record.center) return null;
    const attribution = [record.photographer, record.secondary_creator, record.description]
      .filter(Boolean)
      .join(' ');
    if (
      /(copyright|©|getty|reuters|associated press|used with permission|ESA\/|ESA,|SpaceX|Roscosmos|courtesy of)/i.test(
        attribution
      )
    )
      return null;
    const manifest =
      hosted(item.href, 'images-assets.nasa.gov') ||
      'https://images-api.nasa.gov/asset/' + encodeURIComponent(record.nasa_id);
    let urls, original;
    if (kind === 'video') {
      const payload = await readJson(manifest, signal);
      const all = (Array.isArray(payload) ? payload : (payload.collection?.items || []).map((i) => i.href))
        .map((x) => hosted(x, 'images-assets.nasa.gov'))
        .filter((x) => x && suffixKind(x) === 'video');
      urls = [...new Set(all)].sort((a, b) => nasaQuality(a) - nasaQuality(b));
      original = all.find((file) => /~orig\./i.test(file));
    } else {
      urls = (item.links || [])
        .filter((link) => link.rel === 'preview' || link.render === 'image')
        .map((link) => hosted(link.href, 'images-assets.nasa.gov'))
        .filter(Boolean);
    }
    if (!urls.length) return null;
    return {
      provider: 'NASA Image and Video Library',
      kind,
      title: clean(record.title),
      url: 'https://images.nasa.gov/details/' + encodeURIComponent(record.nasa_id),
      manifestUrl: manifest,
      originalUrl: original,
      downloadUrl: urls[0],
      alternateUrls: urls.slice(1),
      credit: ['NASA', record.center, record.photographer].filter(Boolean).join(' / '),
      license: 'NASA media usage guidelines',
      licenseUrl: 'https://www.nasa.gov/nasa-brand-center/images-and-media/',
      statement: clean(record.description),
      date: record.date_created,
      evidenceLevel: 'catalog-description',
    };
  });
  const results = await Promise.allSettled(jobs);
  signal?.throwIfAborted();
  if (results.length && results.every((r) => r.status === 'rejected')) throw results[0].reason;
  return results.flatMap((r) => (r.status === 'fulfilled' && r.value ? [r.value] : []));
}
async function openverse(query, readJson, signal) {
  const url = new URL('https://api.openverse.org/v1/images/');
  url.search = new URLSearchParams({ q: query, license: 'cc0,by,by-sa,pdm', page_size: '6' });
  const timeout = AbortSignal.timeout(5000);
  const data = await readJson(url, signal ? AbortSignal.any([signal, timeout]) : timeout);
  return (data.results || [])
    .filter(
      (r) =>
        ['cc0', 'by', 'by-sa', 'pdm'].includes(r.license) &&
        r.foreign_landing_url?.startsWith('https://') &&
        r.url?.startsWith('https://')
    )
    .map((r) => ({
      provider: 'Openverse / ' + clean(r.source),
      kind: 'image',
      title: clean(r.title),
      url: r.foreign_landing_url,
      downloadUrl: r.url,
      license: 'CC ' + r.license.toUpperCase() + ' ' + clean(r.license_version),
      licenseUrl: clean(r.license_url),
      credit: clean(r.creator) || clean(r.attribution),
      statement: clean(r.title),
      date: clean(r.created_on),
      evidenceLevel: 'catalog-description',
    }));
}

// These references describe claims. An illustrative media asset keeps its own separate credit.
export async function searchFacts(query, { signal } = {}) {
  const term = String(query || '')
    .trim()
    .slice(0, 200);
  if (!term) return [];
  const lang = /[\u3400-\u9fff]/.test(term) ? 'zh' : 'en';
  const wiki = new URL('https://' + lang + '.wikipedia.org/w/api.php');
  wiki.search = new URLSearchParams({
    action: 'query',
    generator: 'search',
    gsrsearch: term,
    gsrlimit: '4',
    prop: 'extracts|info',
    inprop: 'url',
    exintro: '1',
    explaintext: '1',
    exsentences: '4',
    format: 'json',
    formatversion: '2',
  });
  const crossref = new URL('https://api.crossref.org/works');
  crossref.search = new URLSearchParams({
    'query.bibliographic': term,
    rows: '5',
    select: 'DOI,title,abstract,published,publisher',
  });
  const [papers, encyclopedia] = await Promise.allSettled([json(crossref, signal), json(wiki, signal)]);
  signal?.throwIfAborted();
  const a =
    papers.status === 'fulfilled'
      ? (papers.value.message?.items || []).map((p) => ({
          url: 'https://doi.org/' + p.DOI,
          title: clean(p.title?.[0]),
          excerpt: clean(p.abstract || p.title?.[0]),
          date: p.published?.['date-parts']?.[0]?.join('-') || '',
          publisher: clean(p.publisher),
          type: 'paper',
        }))
      : [];
  const b =
    encyclopedia.status === 'fulfilled'
      ? (encyclopedia.value.query?.pages || []).map((p) => ({
          url: p.fullurl,
          title: clean(p.title),
          excerpt: clean(p.extract),
          publisher: 'Wikipedia',
          type: 'encyclopedia',
        }))
      : [];
  return [...b, ...a].filter((x) => x.url && x.excerpt);
}
const spaceTerms =
  /太空|太空人|月球|月面|月壤|登月|阿波罗|阿尔忒弥斯|火星|航天|天文|宇航|卫星|空间站|望远镜|\b(nasa|apollo|artemis|orion|moon|mars|space|orbital|telescope|astronaut|satellite|lunar)\b/i;
function nasaQuery(term) {
  const translations = [
    [/国际空间站/g, 'International Space Station'],
    [/阿波罗/g, 'Apollo'],
    [/阿尔忒弥斯/g, 'Artemis'],
    [/月壤/g, 'lunar soil'],
    [/月球|月面/g, 'Moon'],
    [/脚印|靴印|足印/g, 'bootprint'],
    [/登月/g, 'moon landing'],
    [/火星/g, 'Mars'],
    [/宇航员|航天员|太空人/g, 'astronaut'],
    [/太空/g, 'space'],
    [/航天/g, 'spacecraft'],
    [/溅落/g, 'splashdown'],
    [/火箭/g, 'rocket'],
    [/望远镜/g, 'telescope'],
  ];
  let result = term;
  for (const [pattern, word] of translations) result = result.replace(pattern, ' ' + word + ' ');
  return result
    .replace(/[\u3400-\u9fff]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
function interleave(groups) {
  const all = [],
    mirrors = [],
    seen = new Set();
  for (let i = 0; i < Math.max(0, ...groups.map((g) => g.length)); i++)
    for (const group of groups) {
      const item = group[i];
      if (!item || seen.has(item.downloadUrl)) continue;
      seen.add(item.downloadUrl);
      const mirrored = all.some(
        (other) =>
          other.provider !== item.provider &&
          item.statement.length > 100 &&
          other.statement === item.statement &&
          (item.title.includes(other.title) || other.title.includes(item.title))
      );
      (mirrored ? mirrors : all).push(item);
    }
  return { distinct: all, mirrors };
}
export async function searchSources(query, {
  signal, kind = 'any', onDiagnostic, readJson = json, readHtml = publisherHtml, catalogs = publisherCatalogs,
} = {}) {
  const term = String(query || '')
    .trim()
    .slice(0, 200);
  if (!term) return [];
  if (!['any', 'video', 'image'].includes(kind)) throw Error('素材类型须为 any、video 或 image。');
  const space = spaceTerms.test(term) && nasaQuery(term);
  const requests = [];
  for (const type of kind === 'any' ? ['video', 'image'] : [kind]) {
    if (type === 'video') for (const catalog of catalogs) {
      const q = space || term;
      if (catalog.scope.test(q)) requests.push({ name: catalog.name, type,
        result: searchPublisherCatalog(q, catalog, { readHtml, signal, onDiagnostic }) });
    }
    if (space) requests.push({ name: 'NASA', type, result: nasa(space, type, readJson, signal) });
    requests.push({ name: 'Wikimedia Commons', type, result: commons(term, type, readJson, signal) });
    if (type === 'image') requests.push({ name: 'Openverse', type, result: openverse(term, readJson, signal) });
  }
  const settled = await Promise.allSettled(requests.map((r) => r.result));
  signal?.throwIfAborted();
  const groups = { video: [], image: [] },
    failures = [];
  settled.forEach((result, i) => {
    const { name, type } = requests[i];
    if (result.status === 'fulfilled') groups[type].push(result.value);
    else {
      const failure = { provider: name, kind: type, message: String(result.reason?.message || result.reason) };
      failures.push(failure);
      onDiagnostic?.(failure);
    }
  });
  if (failures.length === requests.length)
    throw Error('素材来源暂不可用：' + failures.map((f) => f.provider + ' ' + f.message).join('，'));
  const video = interleave(groups.video),
    image = interleave(groups.image);
  return [
    ...video.distinct.slice(0, 8),
    ...image.distinct.slice(0, Math.max(4, 12 - video.distinct.length)),
    ...video.distinct.slice(8),
    ...video.mirrors,
    ...image.mirrors,
  ].slice(0, 12);
}

function expectedKind(entry) {
  if (['video', 'image', 'audio'].includes(entry.kind)) return entry.kind;
  const file = entry.downloadUrl || entry.url;
  // A GIF may carry a timed animation. Let the actual stream determine its kind.
  return /\.gif$/i.test(new URL(file).pathname) ? undefined : suffixKind(file);
}
export function directSources(project) {
  const list = Array.isArray(project.settings?.sourceUrls) ? project.settings.sourceUrls : [];
  return [...list, ...briefUrls(project).filter(isMediaUrl)]
    .slice(0, 16)
    .map((entry) => (typeof entry === 'string' ? { url: entry } : entry))
    .filter((entry) => entry?.url)
    .map((entry) => ({
      provider: clean(entry.provider || '用户提供'),
      title: clean(entry.title || new URL(entry.url).pathname.split('/').pop() || '素材'),
      url: entry.url,
      downloadUrl: entry.downloadUrl || entry.url,
      kind: expectedKind(entry),
      credit: clean(entry.credit || '用户提供'),
      license: clean(entry.license || '使用范围待核'),
      licenseUrl: clean(entry.licenseUrl || ''),
      statement: clean(entry.statement || ''),
      date: clean(entry.date || ''),
      evidenceLevel: 'provided-description',
    }));
}
