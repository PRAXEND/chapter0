import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, readFile, readlink, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { childEnvironment, prepareProfile, privateRollout, workbenchLegacy } from '../src/codex-profile.mjs';

async function fixture(t) {
  const dir = await realpath(await mkdtemp(path.join(os.tmpdir(), 'studio-profile-test-')));
  t.after(() => rm(dir, {recursive:true,force:true}));
  const desktop = path.join(dir,'desktop'), home = path.join(dir,'studio');
  await mkdir(desktop,{mode:0o700});
  const open = (credentialMode='file',extra={}) => prepareProfile({
    home,desktop,settings: async () => ({credentialMode,...extra}),
  });
  return {dir,desktop,home,open};
}

test('only the confirmed file-backed identity and its refresh lock are shared across new private profiles',async t=>{
  const f=await fixture(t), shared=path.join(f.desktop,'auth.json');
  await writeFile(shared,'fixture',{mode:0o600});
  const [a,b]=await Promise.all([f.open(),f.open()]);
  assert.equal(a.storeId,b.storeId);assert.equal(a.accountSource,'desktop-file');
  for(const name of ['auth.json','auth.lock'])assert.equal(await readlink(path.join(f.home,name)),path.join(f.desktop,name));
  const other=await f.open('keyring');
  assert.equal(other.accountSource,'studio');
  for(const name of ['auth.json','auth.lock'])await assert.rejects(lstat(path.join(f.home,name)),{code:'ENOENT'});
  assert.equal(await readFile(shared,'utf8'),'fixture');
  await writeFile(path.join(f.home,'auth.json'),'workbench profile',{mode:0o600});
  assert.equal((await f.open()).accountSource,'studio');
  assert.equal(await readFile(path.join(f.home,'auth.json'),'utf8'),'workbench profile');
  assert.equal((await f.open('auto')).accountSource,'studio');
});

test('overlapping roots, an inherited shared sqlite location, or links to desktop chat storage are refused',async t=>{
  const f=await fixture(t);
  await assert.rejects(prepareProfile({home:path.join(f.desktop,'nested'),desktop:f.desktop}),/独立/);
  await mkdir(f.home,{mode:0o700});
  await assert.rejects(f.open('file',{sqliteHome:f.home}),/会话索引/);
  const previous=process.env.CODEX_SQLITE_HOME;
  try{
    process.env.CODEX_SQLITE_HOME=f.home;
    await assert.rejects(f.open(),/会话索引/);
  }finally{if(previous===undefined)delete process.env.CODEX_SQLITE_HOME;else process.env.CODEX_SQLITE_HOME=previous;}
  await chmod(f.home,0o755);await assert.rejects(f.open(),/0700/);
  await chmod(f.home,0o700);await symlink(f.desktop,path.join(f.home,'sessions'));
  await assert.rejects(f.open(),/聊天索引与记录/);
  const env=childEnvironment(f.home);
  assert.equal(env.CODEX_HOME,f.home);assert.equal(env.CODEX_SQLITE_HOME,f.home);
  assert.equal(env.XDG_STATE_HOME,path.join(f.home,'xdg/state'));
  for(const key of ['CODEX_SESSION_ID','CODEX_THREAD_ID','CODEX_TOOL_CALL_ID','CODEX_INTERNAL_ORIGINATOR_OVERRIDE','CODEX_APP_TOOLS_PIPE_PATH'])assert.equal(env[key],undefined);
});

test('a single registered workbench rollout is copied under its own ID; desktop files, unrelated chats and swapped paths survive',async t=>{
  const f=await fixture(t), profile=await f.open(), id=randomUUID(), other=randomUUID();
  const source=path.join(f.desktop,'sessions','2026','01','01');
  await mkdir(source,{recursive:true});
  const old=path.join(source,'rollout-2026-01-01-'+id+'.jsonl');
  await writeFile(old,'initial');
  const thread={id,cwd:path.join(os.tmpdir(),'video-studio-agent-AS123z'),path:old};
  assert.ok(workbenchLegacy(thread,id));
  assert.equal(workbenchLegacy({...thread,cwd:f.dir},id),false);
  await assert.rejects(privateRollout(profile,thread,other),/标识/);
  await assert.rejects(privateRollout(profile,{...thread,path:await realpath(f.desktop)},id),/不属于/);
  const [a,b]=await Promise.all([privateRollout(profile,thread,id),privateRollout(profile,thread,id)]);
  assert.equal(a,b);assert.ok(a.startsWith(f.home+'/sessions/'));
  await writeFile(a,'continued only in Studio');
  assert.equal(await readFile(old,'utf8'),'initial');
  assert.equal(await readFile(await privateRollout(profile,thread,id),'utf8'),'continued only in Studio');
  assert.equal(await lstat(a).then(s=>s.mode&0o777),0o600);
});
