import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { startStudio } from '../src/server.mjs';

const [snapshot, destination] = process.argv.slice(2);
if (!snapshot || !destination) throw Error('用法：node replay-topic.mjs <原工程 JSON> <新的验证目录>');
const original = JSON.parse(await readFile(snapshot, 'utf8'));
if (original.mode !== 'topic') throw Error('此验证从空素材库重做选题工程。');
const settings = original.settings || {};
if (!['system', undefined].includes(settings.voiceMode) || settings.musicMode === 'asset') {
  throw Error('请用无需预先导入声音文件的选题工程执行此对照。');
}

const resources = process.env.VIDEO_STUDIO_RESOURCE_DIR;
if (resources && !process.env.VIDEO_STUDIO_CODEX) {
  const relative = (await readFile(path.join(resources, 'codex-executable.txt'), 'utf8')).trim();
  process.env.VIDEO_STUDIO_CODEX = path.resolve(resources, 'codex-runtime', relative);
}
let cliVersion;
if (process.env.VIDEO_STUDIO_CODEX) {
  await access(process.env.VIDEO_STUDIO_CODEX, constants.X_OK);
  const version = await promisify(execFile)(process.env.VIDEO_STUDIO_CODEX, ['--version']);
  cliVersion = version.stdout.trim();
}

// EEXIST protects the original project and all earlier candidates.
const root = path.resolve(destination);
await mkdir(root, { mode: 0o700 });
const service = await startStudio({ root });
try {
  const login = await fetch(service.url, { redirect: 'manual' });
  const origin = new URL(service.url).origin;
  const cookie = login.headers.get('set-cookie')?.split(';')[0];
  async function api(route, body) {
    const response = await fetch(origin + route, {
      method: body ? 'POST' : 'GET',
      headers: { cookie, origin, 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    const value = await response.json();
    if (!response.ok) throw Error(value.error || String(response.status));
    return value;
  }

  // Only producer inputs go through the normal project and job endpoints. The old cut,
  // the old assistant thread, its discovered facts and its selected media never enter the new project.
  const { mode, title, brief, script, profile, style } = original;
  const inputs = Object.fromEntries([
    'voiceMode', 'systemVoice', 'shareFrames', 'shareTranscript', 'publishPackage', 'musicEnabled',
    'musicMode', 'sceneSound', 'targetDuration', 'reasoningEffort', 'visualRequirements', 'factUrls', 'sourceUrls',
  ].filter(key => settings[key] !== undefined).map(key => [key, settings[key]]));
  const model = process.env.VIDEO_STUDIO_REPLAY_MODEL || settings.model;
  const project = await api('/api/projects', {
    mode, title, brief, script, profile,
    style: { id: style.id, version: style.version },
    settings: { ...inputs, model, cloudEnabled: false, cloudBudget: 0 },
  });
  const queued = await api('/api/projects/' + project.id + '/jobs', {
    kind: 'produce', engine: 'codex', baseRevision: project.revision,
  });

  let lastEventAt;
  for (;;) {
    const job = await api('/api/jobs/' + queued.id);
    const event = job.events?.at(-1);
    if (event && event.at !== lastEventAt) {
      lastEventAt = event.at;
      console.log(event.at, event.message);
    }
    if (['done', 'failed', 'paused'].includes(job.status)) {
      const final = service.store.getJob(job.id);
      const summary = {
        projectId: project.id, jobId: job.id, threadId: service.store.get(project.id).threadId,
        cliVersion, model, reasoningEffort: inputs.reasoningEffort,
        status: job.status, error: job.error, revision: job.revision, creativeEngine: job.creativeEngine,
        qa: job.qa?.status, issues: job.qa?.issues?.map(issue => issue.message || issue.reason),
        published: final.published, files: final.files,
      };
      const outcome = path.join(root, 'outcome.json');
      await writeFile(outcome, JSON.stringify(summary, null, 2) + '\n');
      console.log(job.status, job.qa?.label || job.error || '', outcome);
      if (job.status !== 'done') process.exitCode = 1;
      break;
    }
    await delay(2000);
  }
} finally {
  await service.close();
}
