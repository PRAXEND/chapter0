// A directory describes a collection and its rights statement. Its media links come from the publisher.
export const publisherCatalogs = [
  {
    name: 'Apollo Lunar Surface Journal',
    directory: 'https://apollojournals.org/alsj/alsj-video.html',
    scope: /\b(?:apollo(?:\s*\d+)?|moon|moonwalk|lunar)\b/i,
    collectionLabel: /^Apollo\s+\d+\s+Clips$/i,
    collectionIdentifier: /\bApollo\s*\d+\b/i,
    licenseText: /\bthe video clips are in the public domain\b/i,
    license: 'Public domain',
    credit: 'NASA / Apollo Lunar Surface Journal',
    digitization: { mpg: 'Ken Glover', mpeg: 'Ken Glover', mov: 'Gerald Megason' },
  },
];

const stop = new Set(
  'a an and are as at by film footage for from in is it its lunar media moon of on or original scene show showing the to video with'.split(
    ' '
  )
);
const videoSuffix = /\.(?:mp4|webm|m4v|mpg|mpeg|mov|ogv)$/i;
const restrictions =
  /copyright|all rights reserved|\bpermission\b|courtesy|third.party|non.commercial|no.derivatives|©/i;

function text(html) {
  return html
    .replace(/<[^>]*>/g, ' ')
    .replace(/&(?:nbsp|#160);/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function links(html, page) {
  const result = [];
  for (const match of html.matchAll(
    /<a\b[^>]*?\shref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>([\s\S]*?)<\/a\s*>/gi
  )) {
    try {
      const url = new URL((match[1] ?? match[2] ?? match[3]).replace(/&amp;/gi, '&'), page);
      if (url.origin === new URL(page).origin && !url.username && !url.password)
        result.push({ url, label: text(match[4]) });
    } catch {
      /* malformed catalog entry */
    }
  }
  return result;
}

function rows(html, page, catalog) {
  const clean = html.replace(/<!--[\s\S]*?-->|<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, '');
  const firstCaption = clean.search(/<(?:blockquote|figcaption)\b/i);
  if (firstCaption < 0) return [];
  const headerText = text(clean.slice(0, firstCaption));
  if (!catalog.licenseText.test(headerText)) return [];
  const records = [];
  // A caption can describe only the link in the immediately preceding paragraph or its own figure.
  // Ignore a row with several distinct video links: it may describe different edits or rights.
  const add = (head, caption) => {
    const statement = text(caption),
      header = text(head);
    if (!statement || restrictions.test(header + ' ' + statement)) return;
    const anchors = links(head, page);
    const media = [
      ...new Set(anchors.filter((a) => videoSuffix.test(a.url.pathname)).map((a) => a.url.href)),
    ];
    if (media.length !== 1) return;
    const original = new URL(media[0]),
      extension = original.pathname.split('.').pop().toLowerCase();
    const byline = (head + ' ' + caption).match(/\bby\s*<font\b[^>]*>([^<]{2,90})<\/font>/i)?.[1];
    const collectionCredit = catalog.digitization?.[extension];
    // Only use a default explicitly corroborated by this page's publisher credit.
    const formats =
      extension === 'mov' ? 'QuickTime' : extension === 'mpg' || extension === 'mpeg' ? 'MP(?:E)?G' : null;
    const defaultApplies =
      collectionCredit &&
      formats &&
      new RegExp(
        formats +
          '\\s+clips?\\s+(?:are\\s+)?by\\s+' +
          collectionCredit.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
        'i'
      ).test(headerText);
    const credit = [catalog.credit, text(byline || (defaultApplies ? collectionCredit : ''))]
      .filter(Boolean)
      .join(' / ');
    const journal = anchors.find((a) => a.url.hash && !videoSuffix.test(a.url.pathname));
    records.push({
      provider: catalog.name,
      kind: 'video',
      title: statement.split(/(?<=[.!?])\s/)[0].slice(0, 135),
      statement: statement.slice(0, 800),
      url: journal?.url.href || page,
      downloadUrl: original.href,
      originalUrl: original.href,
      catalogUrl: page,
      license: catalog.license,
      licenseUrl: page,
      credit,
      evidenceLevel: 'catalog-description',
    });
  };
  for (const figure of clean.matchAll(/<figure\b[^>]*>([\s\S]*?)<\/figure>/gi)) {
    const caption = figure[1].match(/<figcaption\b[^>]*>([\s\S]*?)<\/figcaption>/i);
    if (caption) add(figure[1].replace(caption[0], ''), caption[1]);
  }
  let previousEnd = 0;
  for (const entry of clean.matchAll(/<blockquote\b[^>]*>([\s\S]*?)<\/blockquote\s*>/gi)) {
    const before = clean.slice(previousEnd, entry.index),
      paragraphs = before.split(/<p\b[^>]*>/i);
    if (paragraphs.length > 1) {
      const last = paragraphs.at(-1);
      // Another block after a paragraph ends its association with a following caption.
      if (!/<(?:hr|h[1-6]|table|div|figure|ul|ol)\b/i.test(last)) add(last, entry[1]);
    }
    previousEnd = entry.index + entry[0].length;
  }
  return records;
}

function terms(input) {
  return new Set(
    (
      input
        .toLowerCase()
        .replace(/['’]s\b/g, '')
        .match(/[\p{L}\p{N}]+/gu) || []
    )
      .filter((w) => w.length > 1 && !stop.has(w))
      .map((w) => (w.length > 4 && w.endsWith('s') ? w.slice(0, -1) : w))
  );
}

export async function searchPublisherCatalog(query, catalog, { readHtml, signal, onDiagnostic }) {
  const identifier = catalog.collectionIdentifier
    ? query.match(catalog.collectionIdentifier)?.[0]
    : undefined;
  const wanted = terms(identifier ? query.replace(identifier, '') : query);
  if (!wanted.size) return [];
  const index = await readHtml(catalog.directory, signal);
  const collections = links(index, catalog.directory).filter(({ label }) =>
    catalog.collectionLabel.test(label)
  );
  const key = (s) => s?.replace(/\s/g, '').toLowerCase();
  const selected = collections.filter(
    ({ label }) => !identifier || key(label.match(catalog.collectionIdentifier)?.[0]) === key(identifier)
  );
  const pages = [...new Set(selected.map((c) => c.url.href))].slice(0, 8);
  const loaded = await Promise.allSettled(
    pages.map(async (page) => rows(await readHtml(page, signal), page, catalog))
  );
  signal?.throwIfAborted();
  if (loaded.length && loaded.every((r) => r.status === 'rejected')) throw loaded[0].reason;
  const documents = [];
  for (const [i, result] of loaded.entries()) {
    if (result.status === 'fulfilled') documents.push(...result.value);
    else
      onDiagnostic?.({
        provider: catalog.name,
        kind: 'video',
        message: pages[i] + ' ' + result.reason.message,
      });
  }
  const indexed = documents.map((record) => ({ record, tokens: terms(record.statement) }));
  const weights = [...wanted].map((term) => [
    term,
    Math.log(1 + (1 + indexed.length) / (1 + indexed.filter((row) => row.tokens.has(term)).length)),
  ]);
  const total = weights.reduce((sum, [, weight]) => sum + weight, 0);
  return indexed
    .map(({ record, tokens }) => {
      const score = weights.reduce((sum, [term, weight]) => sum + (tokens.has(term) ? weight : 0), 0);
      return { record, score: score / total };
    })
    .filter((row) => row.score >= 0.55)
    .sort((a, b) => b.score - a.score || a.record.statement.length - b.record.statement.length)
    .slice(0, 4)
    .map((row) => row.record);
}
