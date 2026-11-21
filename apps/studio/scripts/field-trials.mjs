import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import * as media from '../src/media.mjs';
import * as audio from '../src/audio.mjs';
import { createDirector } from '../src/production.mjs';
import { createStore } from '../src/project.mjs';
import { createStyleLibrary } from '../src/style.mjs';
import { portableProject } from '../src/library.mjs';
import { reviewProject, readSrt } from '../src/review.mjs';
import { footage } from './review-sources.mjs';

const [sourceArg, targetArg, mode = 'all'] = process.argv.slice(2);
if (!sourceArg || !targetArg || !['all','asr','interview','aspects'].includes(mode))
  throw Error('使用 node scripts/field-trials.mjs <盲评库的 research-sources> <专用新目录> [all|asr|interview|aspects]');
const sources = path.resolve(sourceArg), target = path.resolve(targetArg);
const exec = promisify(execFile), fps = 25;
const save = async (file, value) => { await writeFile(file + '.tmp', JSON.stringify(value, null, 2) + '\n'); await rename(file + '.tmp', file); };
const json = file => readFile(file, 'utf8').then(JSON.parse).catch(error => { if (error.code !== 'ENOENT') throw error; return null; });
await mkdir(target, { recursive: true });
if (!(await readdir(target)).includes('field-trials.json')) {
  if ((await readdir(target)).length) throw Error('请选择空的实测目录，以保留已有资料库。');
  await save(path.join(target, 'field-trials.json'), { schema: 1, sources });
}
const marker = await json(path.join(target, 'field-trials.json'));
assert.equal(marker.schema, 1); assert.equal(marker.sources, sources);
const store = createStore(path.join(target, 'library'), { probeMedia: media.probeMedia });
const styles = createStyleLibrary(target, { legacyHome: false });
const director = createDirector({ store, media, audio, styleLibrary: styles });
const license = 'NASA educational media, credit NASA. https://www.nasa.gov/nasa-brand-center/images-and-media/';
const provenance = key => ({ name: key + '.mp4', url: 'https://images.nasa.gov/details/' + encodeURIComponent(footage[key][0]), credit: 'NASA', rights: license });
async function checked(key) {
  const file = path.join(sources, key + '.mp4');
  assert.equal(await media.fileHash(file), footage[key][1], '原片须与研究资料的固定 SHA-256 一致');
  return file;
}
const interviewState = path.join(target, 'interview.json');
const question = '从 Jeanette Epps 这段英文原声中，选她讲欧洲洞穴训练的一组问题和完整回答。剪45至70秒。开头直接进入洞穴训练问题，接她解释训练与月球环境的关系、在洞穴中做了什么或学到什么。使用连续的实际英文语句，讲完一句再切，保留原话和原声，不加旁白或额外配乐。';
async function transcription() {
  let record = await json(interviewState);
  if (!record) {
    const p = store.create({ title: 'Jeanette Epps 谈洞穴训练', mode: 'interview', brief: question, profile: { width: 960, height: 540, fps }, settings: { engine: 'codex', voiceMode: 'original', requireCaptions: true, musicMode: 'none', shareFrames: false, shareTranscript: true, reasoningEffort: 'medium' } });
    const a = await store.addAsset(p.id, await checked('interview'), provenance('interview'));
    record = { projectId: p.id, assetId: a.id, sourceSha256: a.sha256, sourceSeconds: a.duration, sourceUrl: provenance('interview').url };
    await save(interviewState, record);
  }
  if (!record.asr) {
    const p = store.get(record.projectId);
    assert.equal(p.transcript?.[record.assetId]?.length || 0, 0, '首轮须从本工程空转录缓存启动');
    assert.equal((await readdir(store.paths(p.id).cache)).length, 0);
    const available = await audio.audioCapabilities();
    assert.ok(available.transcription, '需准备 whisper.cpp 与多语言权重');
    const started = Date.now();
    const rows = await director.transcribe(p.id, { assetId: record.assetId });
    assert.ok(rows.length > 60 && rows.at(-1).end > record.sourceSeconds * 0.90);
    await save(path.join(target, 'interview-transcript.json'), rows);
    record.asr = { engine: 'whisper.cpp', model: path.basename(available.whisperModel), emptyProjectCache: true, inputSeconds: record.sourceSeconds, utterances: rows.length, first: rows[0].start, last: rows.at(-1).end, elapsedSeconds: (Date.now()-started)/1000 };
    await save(interviewState, record);
  }
  console.log(JSON.stringify(record.asr));
  return record;
}

const track = (p, name) => p.timeline.clips.filter(c => c.track === name && !c.hidden && c.enabled !== false).sort((a, b) => a.start - b.start);
async function freeze(p, label) {
  const directory = path.join(target, label), reportPath = path.join(directory, 'checks.json');
  const prior = await json(reportPath);
  if (prior) { assert.equal(prior.revision, p.revision); return prior; }
  await mkdir(directory, { recursive: true });
  const render = await media.renderProject(p, { directory, output: path.join(directory,'video.mp4') });
  const probe = await media.probeMedia(render.videoPath), check = await reviewProject(p, render);
  const subtitles = readSrt(await readFile(render.srtPath, 'utf8'));
  assert.ok(check.evidence.decode && check.candidatePlayable && probe.hasAudio);
  assert.equal(probe.frames, Math.max(...p.timeline.clips.map(c => c.start + c.duration)));
  assert.equal(subtitles.length, track(p, 'caption').length);
  assert.equal(probe.width, p.profile.width); assert.equal(probe.height, p.profile.height);
  const windows = check.evidence.audio.flatMap(c => c.windows || []);
  const correlated = windows.filter(w => w.similarity >= 0.65 && Math.abs(w.offset) <= 0.18);
  assert.ok(windows.length && correlated.length >= windows.length * .8, '独立音频窗口应与所选原件的源时码一致');
  const portable = await portableProject(p, path.join(directory, '工程'), styles);
  const reopened = await store.importSnapshot(portable, styles);
  assert.deepEqual(reopened.timeline.clips, p.timeline.clips);
  assert.deepEqual(reopened.assets.map(a => a.sha256), p.assets.map(a => a.sha256));
  const report = { revision: p.revision, engine: render.engine, frames: probe.frames, duration: probe.duration, dimensions: [probe.width, probe.height], videoCodec: probe.videoCodec, audioCodec: probe.audioCodec, sha256: render.sha256, video: render.videoPath, srt: render.srtPath, portable, reopenedProject: reopened.id, tracks: Object.fromEntries(['video','narration','music','caption','graphic'].map(t => [t,track(p,t).length])), originalAudioWindows: windows.length, correlatedAudioWindows: correlated.length, status: check.status, issues: check.issues, fullDecode: check.evidence.decode };
  await save(path.join(directory, 'review.json'), check);
  await save(reportPath, report);
  console.log(label, report.frames, report.status);
  return report;
}
async function interview() {
  const record = await transcription();
  if (!record.sequence) {
    const started = Date.now();
    const result = await director.run(record.projectId, { kind: 'produce', engine: 'codex', message: question, jobId: 'field-interview', onEvent: e => { if(e.type==='progress') console.log(e.message); } });
    assert.equal(result.engine, 'codex');
    const p = result.project;
    assert.ok(p.storyboard.length > 2 && p.storyboard.every(s => s.assetId === record.assetId && s.utteranceId));
    record.sequence = { elapsedSeconds: (Date.now() - started)/1000, revision: p.revision, threadId: p.threadId, utterances: p.storyboard.map(s => s.utteranceId), continuity: p.storyboard.map(s => s.continuity) };
    await save(interviewState, record);
  }
  const first = store.revision(record.projectId, record.sequence.revision);
  const original = await freeze(first, '访谈/01-初剪');
  const rows = first.transcript[record.assetId], cuts = track(first, 'video');
  assert.ok(original.duration >= 35 && original.duration <= 82);
  assert.ok(cuts.every((c, i) => c.assetId === record.assetId && c.gain > 0 && (!i || cuts[i-1].start + cuts[i-1].duration === c.start)));
  if (!record.removal) {
    const ordered = cuts.slice(1,-1).map(c => ({ c, row: rows.find(r => Math.round(r.start*fps) === c.sourceIn), caption: track(first,'caption').find(t => t.start === c.start) }));
    const valid = ordered.filter(({ c,row,caption }) => row && caption && Math.round(row.end*fps)-c.sourceIn === c.duration && track(first,'caption').filter(t => t.text === row.text).length === 1);
    const sample = valid.find(({row}) => /visited several caves|underground world|total of six days|what can you tell/i.test(row.text)) || valid[Math.floor(valid.length/2)];
    assert.ok(sample, '需要一段边界明确且可试听的原句');
    const { c,row,caption } = sample;
    const shift = first.timeline.clips.filter(t => t.start >= c.start+c.duration).map(t => ({ op:'update', id:t.id, changes:{start:t.start-c.duration} }));
    const p = store.apply(first.id, first.revision, [{op:'remove',id:c.id},{op:'remove',id:caption.id},...shift], 'user');
    record.removal = { utteranceId:row.id, text:row.text, sourceStart:row.start, sourceEnd:row.end, frames:c.duration, atFrame:c.start, revision:p.revision };
    await save(interviewState, record);
  }
  const del = record.removal, removed = store.revision(record.projectId, del.revision);
  assert.equal(track(removed, 'caption').filter(c => c.text === del.text).length, 0);
  const cut = await freeze(removed, '访谈/02-删除原句');
  if (!record.restored) {
    const options={assetId:record.assetId, utteranceId:del.utteranceId};
    const restored = await director.restoreUtterance(first.id, {...options,baseRevision:removed.revision});
    const again = await director.restoreUtterance(first.id, {...options,baseRevision:restored.revision});
    assert.equal(again.revision, restored.revision); assert.deepEqual(again.timeline.clips, restored.timeline.clips);
    assert.equal(track(restored,'caption').filter(c => c.text === del.text && c.start === del.atFrame).length, 1);
    assert.deepEqual(track(restored,'video').map(c => [c.assetId,c.sourceIn,c.start,c.duration]), cuts.map(c => [c.assetId,c.sourceIn,c.start,c.duration]));
    record.restored = { revision:restored.revision, repeatedRevision:again.revision, matchingCaptions:1, sameSourceAndTimelineWindows:true };
    await save(interviewState,record);
  }
  const restored = await freeze(store.revision(first.id, record.restored.revision),'访谈/03-恢复原句');
  assert.equal(original.frames-cut.frames, del.frames); assert.equal(restored.frames, original.frames);
  if (!record.readback) {
    const words = s => s.toLowerCase().match(/[a-z0-9]+/g) || [];
    const expected = words(del.text), triples = expected.slice(2).map((_,i) => expected.slice(i,i+3).join(' '));
    const verify = async output => {
      const rows = await audio.transcribe(output.video, {directory:path.dirname(output.video),language:'en'});
      const said = words(rows.map(r=>r.text).join(' ')).join(' ');
      return { segments:rows.length, deletedUtteranceMatch:triples.filter(t=>said.includes(t)).length/Math.max(1,triples.length) };
    };
    const intact = await verify(original), shorter = await verify(cut);
    const recovered = original.sha256===restored.sha256 ? intact : await verify(restored);
    assert.ok(intact.deletedUtteranceMatch>.45 && shorter.deletedUtteranceMatch<intact.deletedUtteranceMatch*.55 && recovered.deletedUtteranceMatch>.45, '重听成片应能区分原句删除与恢复');
    record.readback = { method:'whisper.cpp transcript of rendered AAC, fraction of original 3-word groups found', original:intact, deleted:shorter, restored:recovered, restoredFileIdentical:original.sha256===restored.sha256 };
  }
  record.outputs = { original, deleted:cut, restored }; await save(interviewState,record);
}
async function thumbnail(file, seconds) {
  const ffmpeg = await media.mediaTool('ffmpeg');
  const result = await exec(ffmpeg, ['-nostdin','-v','error','-ss',String(seconds),'-i',file,'-an','-vf','scale=96:96','-frames:v','1','-pix_fmt','rgb24','-f','rawvideo','pipe:1'], {encoding:'buffer'});
  assert.equal(result.stdout.length,96*96*3); return result.stdout;
}
async function delta(left,right,sec) {
  const [a,b]=await Promise.all([thumbnail(left,sec),thumbnail(right,sec)]);
  return Number((a.reduce((n,x,i)=>n+Math.abs(x-b[i]),0)/a.length).toFixed(3));
}
async function aspects() {
  const source = await checked('launch'), centerCrop = path.join(target,'launch-portrait.mp4');
  const derivative = { ...provenance('launch'), name:'夜间发射-竖版裁切.mp4', parentSha256:footage.launch[1], sourceInSeconds:35.5, sourceOutSeconds:47.5, operation:'center crop 90x160, scale 360x640, retain original audio' };
  if (!(await readdir(target)).includes('launch-portrait.mp4')) {
    await exec(await media.mediaTool('ffmpeg'), ['-nostdin','-v','error','-ss','35.5','-i',source,'-t','12','-vf','crop=90:160,scale=360:640,setsar=1','-c:v','libx264','-preset','veryfast','-c:a','aac','-ar','48000',centerCrop+'.tmp.mp4']);
    await rename(centerCrop+'.tmp.mp4',centerCrop);
  }
  const portrait = await media.probeMedia(centerCrop); assert.equal(portrait.width*16,portrait.height*9); assert.ok(portrait.hasAudio);
  const script = '在移动发射平台下方，可以看到履带和旁边的工作人员。\n夜里，火箭下方的亮光照亮发射塔。\n海面上，降落伞下的返回舱溅起水花。';
  for (const [label,width,height,index] of [['横版',1280,720,1],['竖版',720,1280,2]]) {
    const stateFile=path.join(target,label+'.json');
    let state=await json(stateFile);
    if (!state) {
      const p=store.create({title:'阿尔忒弥斯一号：地面到溅落（'+label+'）',mode:'script',brief:'把三个真实镜头按地面运输、发射和海上回收排序。',script,profile:{width,height,fps},settings:{engine:'local',voiceMode:'system',systemVoice:'Tingting',musicMode:'library',requireMusic:true,requireCaptions:true}});
      await store.addAsset(p.id,await checked('lift'),provenance('lift'));
      await store.addAsset(p.id,centerCrop,derivative);
      await store.addAsset(p.id,await checked('splash'),provenance('splash'));
      const {project}=await director.run(p.id,{kind:'produce',engine:'local'});
      const shots=track(project,'video'), voices=track(project,'narration');
      assert.equal(shots.length,3);assert.equal(voices.length,3);
      const ops=shots.map((c,i)=>({op:'update',id:c.id,changes:{sourceIn:[319,2.4,97][i]*fps,fit:'contain'}}));
      ops.push({op:'lock',id:voices[index].id,locked:true},{op:'add',clip:{id:'editable-title',track:'graphic',start:0,duration:38,text:'阿尔忒弥斯一号',geometry:{x:.5,y:.22},style:{fontSize:34},keyframes:[{frame:0,opacity:.3},{frame:10,opacity:1}]}});
      const first=store.apply(p.id,project.revision,ops,'user');
      const second=store.apply(p.id,first.revision,[{op:'update',id:shots[index].id,changes:{sourceIn:track(first,'video')[index].sourceIn+5,fit:'cover'}}],'user');
      assert.deepEqual(track(first,'narration'),track(second,'narration'));
      assert.deepEqual(track(first,'caption'),track(second,'caption'));
      const others=p=>p.timeline.clips.filter(c=>c.id!==shots[index].id);
      assert.deepEqual(others(first),others(second));
      const a=first.assets.find(a=>a.id===shots[index].assetId);
      state={projectId:p.id,before:first.revision,after:second.revision,editedId:shots[index].id,editedAssetDimensions:[a.width,a.height],originals:[footage.lift[1],footage.launch[1],footage.splash[1]],portraitSource:derivative,lockedNarration:voices[index].id};
      await save(stateFile,state);
    }
    const first=store.revision(state.projectId,state.before), reframed=store.revision(state.projectId,state.after);
    const before=await freeze(first,label+'/01-初剪'), crop=await freeze(reframed,label+'/02-调整构图');
    let after=crop;
    if(label==='横版') {
      if(!state.wideRevision){
        const parent=await store.addAsset(state.projectId,source,provenance('launch'));
        const clip=track(first,'video')[index], split=Math.round(clip.duration*.4);
        const p=store.apply(first.id,store.get(first.id).revision,[
          {op:'update',id:clip.id,changes:{fit:'contain',sourceIn:clip.sourceIn,duration:split}},
          {op:'add',clip:{...clip,id:'same-moment-wide-master',assetId:parent.id,fit:'contain',sourceIn:Math.round(derivative.sourceInSeconds*fps)+clip.sourceIn+split,start:clip.start+split,duration:clip.duration-split}}
        ],'user');
        assert.deepEqual(track(p,'narration'),track(first,'narration'));assert.deepEqual(track(p,'caption'),track(first,'caption'));
        assert.equal(track(p,'video').length,4);state.wideRevision=p.revision;await save(stateFile,state);
      }
      after=await freeze(store.revision(first.id,state.wideRevision),label+'/03-回到横向母片');
      state.intermediateCenteredCrop=crop;
    }
    const shot=first.timeline.clips.find(c=>c.id===state.editedId), unchanged=track(first,'video')[0];
    const pixels={ changed:[], unchanged:await delta(before.video,after.video,(unchanged.start+Math.floor(unchanged.duration/2))/fps) };
    for(const f of [.2,.5,.8])pixels.changed.push(await delta(before.video,after.video,(shot.start+Math.floor(shot.duration*f))/fps));
    assert.ok(Math.max(...pixels.changed)>2 && pixels.unchanged<2, '调整构图的镜头应真实变化，锁定段落保持');
    assert.equal(before.frames,after.frames); assert.notEqual(before.sha256,after.sha256);
    state.outputs={before,after};state.pixelMeanDifferenceOutOf255=pixels;await save(stateFile,state);
  }
}
try {
  if (mode === 'asr') await transcription();
  if (mode === 'all' || mode === 'interview') await interview();
  if (mode === 'all' || mode === 'aspects') await aspects();
} finally { director.close(); store.close(); }
