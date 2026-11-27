import assert from 'node:assert/strict';
import {once} from 'node:events';
import http from 'node:http';
import {spawn} from 'node:child_process';
import test from 'node:test';
import {githubRoute} from '../src/github-media.mjs';

const host = 'media.githubusercontent.com';
test('select the configured route only for known GitHub endpoints on each hop', () => {
  const proxy = {https_proxy: 'http://localhost:12345'};
  for (const name of [host, 'raw.githubusercontent.com', 'release-assets.githubusercontent.com'])
    assert.equal(githubRoute(name, proxy, 'darwin'), 'environment');
  assert.equal(githubRoute('media.githubusercontent.com.example.org', proxy, 'darwin'), null);
  assert.equal(githubRoute('example.org', proxy, 'darwin'), null);
  assert.equal(githubRoute(host, {}, 'darwin'), 'system');
  assert.equal(githubRoute(host, {HTTP_PROXY: proxy.https_proxy}, 'darwin'), 'system');
  assert.equal(githubRoute(host, {}, 'linux'), 'direct');
  for (const unsupported of ['socks://localhost', 'HTTP://localhost'])
    assert.throws(() => githubRoute(host, {HTTPS_PROXY:unsupported}, 'darwin'), /HTTPS_PROXY/);
});
test('explicit bypasses apply to both system and environment proxy routes', () => {
  for (const rule of ['*', host, host+':443', '.githubusercontent.com', '*.githubusercontent.com']) {
    assert.equal(githubRoute(host, {NO_PROXY:rule}, 'darwin'), 'direct');
    assert.equal(githubRoute(host, {https_proxy:'https://localhost', no_proxy:rule}, 'darwin'), 'direct');
  }
  assert.equal(githubRoute('github.com', {NO_PROXY:'*.github.com'}, 'darwin'), 'system');
  assert.equal(githubRoute(host, {no_proxy:'', NO_PROXY:host}, 'darwin'), 'direct');
  for (const rule of [host+':80', '.notgithubusercontent.com', 'github.com'])
    assert.equal(githubRoute(host, {no_proxy:rule}, 'darwin'), 'system');
});
test('importSource attempts a real CONNECT through the selected local proxy', async () => {
  const proxy = http.createServer();
  const destinations = [];
  proxy.on('connect', (request, socket) => {
    destinations.push(request.url);
    socket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n');
  });
  proxy.listen(0, '127.0.0.1');
  await once(proxy, 'listening');
  try {
    const source = new URL('../src/sources.mjs', import.meta.url).href;
    const script = `
      import os from 'node:os';
      import dns from 'node:dns/promises';
      import {importSource} from ${JSON.stringify(source)};
      dns.lookup = async () => [{address:'140.82.112.4', family:4}];
      const store = {get:()=>({assets:[]}), paths:()=>({cache:os.tmpdir()})};
      const url = 'https://media.githubusercontent.com/media/example/video.mp4';
      try { await importSource(store,'fixture',{kind:'video',downloadUrl:url},{signal:AbortSignal.timeout(4000)}); }
      catch { process.exitCode=0; }
    `;
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
      env:{...process.env, https_proxy:'http://127.0.0.1:'+proxy.address().port, no_proxy:'', NO_PROXY:''},
      stdio:['ignore','ignore','inherit'],
    });
    const [code] = await once(child, 'close');
    assert.equal(code, 0);
    assert.deepEqual(destinations,[host+':443']);
  } finally { await new Promise(resolve => proxy.close(resolve)); }
});
