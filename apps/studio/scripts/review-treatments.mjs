import {mkdir,readFile,writeFile,rename,access} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash} from 'node:crypto';
import {styleSubjects,stylePrompt} from './review-sources.mjs';
const exec=promisify(execFile);
const [rootArg,codeArg]=process.argv.slice(2);
if(!rootArg) throw Error('使用 node review-treatments.mjs <评测库目录> [工作台src目录]');
const root=path.resolve(rootArg),src=path.resolve(codeArg||fileURLToPath(new URL('../src/',import.meta.url)));
const load=x=>import(pathToFileURL(path.join(src,x)).href);
const {CodexClient}=await load('codex.mjs'),{mediaTool}=await load('media.mjs');
const folder=path.join(root,'research-sources'),record=path.join(root,'research-plan/treatments');
await mkdir(record,{recursive:true});await mkdir(path.join(folder,'evidence'),{recursive:true});
const client=new CodexClient(); const model='gpt-6.2-astra',effort='max';
const tools=[{name:'public_storyboard',description:'读取本段三帧已授权的公共参考画面。',inputSchema:{type:'object',properties:{},required:[],additionalProperties:false}}];
try {
  if(!(await client.account()).connected) throw Error('请先在工作台连接 Codex');
  const requests=[];
  for(const [id,subject] of Object.entries(styleSubjects)) {
    const jpg=path.join(folder,'evidence',id+'-triptych.jpg'),args=['-nostdin','-v','error','-y'];
    for(const ts of subject.frames) args.push('-ss',String(ts),'-i',path.join(folder,id+'.mp4'));
    args.push('-filter_complex','[0:v][1:v][2:v]hstack=inputs=3[v]','-map','[v]','-frames:v','1',jpg);
    await exec(await mediaTool('ffmpeg'),args);
    const image=await readFile(jpg),imageHash=createHash('sha256').update(image).digest('hex');
    for(const style of ['henry-hot-news','henry-technical-explainer']) for(const run of [1,2]) requests.push({id,subject,style,run,image,imageHash});
  }
  // Separate conversations per rendering, identical picture, voice, template and inference configuration.
  async function processOne({id,subject,style,run,image,imageHash}){
    const file=path.join(record,[id,style,run].join('-')+'.json');
    try {await access(file);console.log('复用已冻结决定',id,style,run);return;} catch {}
    const prompt=stylePrompt(subject,style), promptHash=createHash('sha256').update(prompt).digest('hex');
    const threadId=await client.thread(null,tools,'收到创作任务后先调用 public_storyboard 查看实际三帧原片。仅使用画面及用户输入中的事实。按请求返回中文 JSON。',{model});
    let observed=false;
    const response=await client.runTurn({threadId,prompt,effort,signal:AbortSignal.timeout(210000),tool:async ({tool})=>{
      if(tool!=='public_storyboard') throw Error('未知工具');
      observed=true;return {success:true,contentItems:[{type:'inputImage',imageUrl:'data:image/jpeg;base64,'+image.toString('base64')}]};
    }});
    if(!observed) throw Error('该回合没有查阅实际原片');
    const text=response.match(/\{[\s\S]*\}/)?.[0],draft=JSON.parse(text||'null');
    if(!draft || typeof draft.text!=='string'||!draft.text.trim()||[...draft.text].length>13||typeof draft.followup!=='string'||!draft.followup.trim()||[...draft.followup].length>25||!draft.continuity) throw Error('回合给出的画面文字超过模板容量');
    const value={subject:id,style,run,model,effort,promptHash,imageHash,threadId,observedPublicFrames:true,source:'studio-codex-app-server',decision:draft};
    await writeFile(file+'.tmp',JSON.stringify(value,null,2));await rename(file+'.tmp',file);
    console.log('完成独立创作',id,style,run);
  }
  const pending=[...requests];
  async function worker(){while(pending.length) await processOne(pending.shift());}
  const result=await Promise.allSettled([worker(),worker()]);
  for(const failed of result) if(failed.status==='rejected') throw failed.reason;
}finally {client.close();}
