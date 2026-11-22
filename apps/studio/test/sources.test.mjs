import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { directSources, importSource, searchSources } from '../src/sources.mjs';

function catalog(calls) {
  return async (input) => {
    const u = new URL(input);
    calls.push(u);
    if (u.hostname === 'images-api.nasa.gov') {
      const kind = u.searchParams.get('media_type'),
        id = 'example-' + kind;
      return {
        collection: {
          items: [
            {
              data: [
                {
                  nasa_id: id,
                  media_type: kind,
                  center: 'HQ',
                  title: 'Original mission footage',
                  description: 'A public observation.',
                },
              ],
              href: 'https://images-assets.nasa.gov/' + id + '/collection.json',
              links: [{ rel: 'preview', render: 'image', href: 'https://images-assets.nasa.gov/poster.jpg' }],
            },
          ],
        },
      };
    }
    if (u.hostname === 'images-assets.nasa.gov')
      return [
        'https://images-assets.nasa.gov/poster.jpg',
        'https://images-assets.nasa.gov/reel~orig.mp4',
        'https://images-assets.nasa.gov/reel~medium.mp4',
        'https://images-assets.nasa.gov/reel~small.mp4',
      ];
    if (u.hostname === 'api.openverse.org') return { results: [] };
    const type = u.searchParams.get('prop');
    if (type === 'imageinfo') return { query: { pages: [] } };
    assert.equal(type, 'videoinfo');
    assert.match(u.searchParams.get('gsrsearch'), /filetype:video/);
    const info = {
      mime: 'application/ogg',
      size: 900000000,
      url: 'https://upload.wikimedia.org/full.ogv',
      descriptionurl: 'https://commons.wikimedia.org/wiki/File:Film.ogv',
      extmetadata: { LicenseShortName: { value: 'CC BY-SA 4.0' }, Artist: { value: 'Example artist' } },
      derivatives: [
        {
          src: 'https://upload.wikimedia.org/clip.webm?utm_content=size',
          type: 'video/webm; codecs="vp9"',
          width: 720,
        },
        { src: 'https://upload.wikimedia.org/poster.jpg', type: 'image/jpeg' },
      ],
    };
    return {
      query: {
        pages: [
          { title: 'File:Film.ogv', videoinfo: [info] },
          {
            title: 'File:Restricted.ogv',
            videoinfo: [{ ...info, extmetadata: { LicenseShortName: { value: 'CC BY-ND 4.0' } } }],
          },
        ],
      },
    };
  };
}

test('catalogs return attributable native videos and the official manifest rendition, never its cover', async () => {
  const calls = [],
    rows = await searchSources('月面靴印', { kind: 'video', readJson: catalog(calls) });
  assert.deepEqual(
    rows.map((r) => r.kind),
    ['video', 'video']
  );
  assert.ok(calls.every((u) => u.hostname !== 'api.openverse.org'));
  assert.equal(calls.find((u) => u.hostname === 'images-api.nasa.gov').searchParams.get('q'), 'Moon bootprint');
  assert.equal(rows[0].downloadUrl, 'https://images-assets.nasa.gov/reel~medium.mp4');
  assert.deepEqual(rows[0].alternateUrls, [
    'https://images-assets.nasa.gov/reel~small.mp4',
    'https://images-assets.nasa.gov/reel~orig.mp4',
  ]);
  assert.equal(rows[1].downloadUrl, 'https://upload.wikimedia.org/clip.webm');
  assert.equal(rows[1].credit, 'Example artist');
  const both = await searchSources('Moon', { readJson: catalog([]) });
  assert.deepEqual(
    both.map((r) => r.kind),
    ['video', 'video', 'image']
  );
  assert.equal(both[2].downloadUrl, 'https://images-assets.nasa.gov/poster.jpg');
});

test('provider errors, an empty catalog and an explicitly requested media type have different outcomes', async () => {
  const failures = [];
  const readJson = async (u) => {
    if (new URL(u).hostname === 'api.openverse.org') throw Error('HTTP 429');
    return { query: { pages: [] } };
  };
  assert.deepEqual(
    await searchSources('butterfly', { kind: 'image', readJson, onDiagnostic: (f) => failures.push(f) }),
    []
  );
  assert.equal(failures[0].provider, 'Openverse');
  await assert.rejects(
    searchSources('butterfly', {
      kind: 'video',
      readJson: async () => {
        throw Error('offline');
      },
    }),
    /Wikimedia Commons offline/
  );
  const ctrl = new AbortController();
  ctrl.abort();
  await assert.rejects(searchSources('Moon', { signal: ctrl.signal, readJson: catalog([]) }), {
    name: 'AbortError',
  });
});

test('direct public film and its source page survive download, retries and incorrect still metadata', async (t) => {
  const folder = await mkdtemp(path.join(os.tmpdir(), 'studio-source-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const page = 'https://publisher.example/collection',
    primary = 'https://publisher.example/film.mpg',
    alternate = 'https://publisher.example/film-low.mpg';
  const [candidate] = directSources({
    settings: {
      sourceUrls: [
        { url: page, downloadUrl: primary, credit: 'Film archive', license: 'Public domain', licenseUrl: page },
      ],
    },
  });
  assert.equal(candidate.kind, 'video');
  assert.equal(candidate.url, page);
  const calls = [],
    assets = [],
    store = {
      get: () => ({ assets }),
      paths: () => ({ cache: folder }),
      async addAsset(id, file, source) {
        const item = { kind: 'video', bytes: await readFile(file, 'utf8'), source };
        assets.push(item);
        return item;
      },
    };
  const openMedia = async (url, signal, _, { maxBytes }) => {
    assert.ok(maxBytes > 81633284);
    calls.push(url);
    if (url === primary) throw Error('超过大小限制');
    const res = Readable.from(['verified local stream']);
    res.headers = { 'content-type': 'video/mpeg' };
    return res;
  };
  const options = { openMedia, probe: async () => ({ kind: 'video' }) };
  const asset = await importSource(store, 'p', { ...candidate, alternateUrls: [alternate] }, options);
  assert.deepEqual(calls, [primary, alternate]);
  assert.equal(asset.source.url, page);
  assert.equal(asset.source.downloadUrl, alternate);
  assert.equal(asset.source.credit, 'Film archive');
  assert.equal(asset.source.licenseUrl, page);
  assert.equal(await importSource(store, 'p', candidate, options), asset);
  assert.equal(assets.length, 1);
  await assert.rejects(
    importSource(
      store,
      'p',
      { ...candidate, downloadUrl: 'https://publisher.example/mistaken.mpg' },
      { ...options, probe: async () => ({ kind: 'image' }) }
    ),
    /实际文件是 image/
  );
  assert.equal(assets.length, 1);
  assert.deepEqual(await readdir(folder), []);
  const attempts = [];
  await assert.rejects(
    importSource(
      store,
      'p',
      { ...candidate, downloadUrl: 'https://publisher.example/busy.mpg', alternateUrls: [alternate] },
      {
        openMedia: async (url) => {
          attempts.push(url);
          throw Object.assign(Error('429'), { status: 429 });
        },
      }
    ),
    /429/
  );
  assert.equal(attempts.length, 1);
});
