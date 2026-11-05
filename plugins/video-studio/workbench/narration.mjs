import {AppServerConnection} from './desktop-rpc.mjs';

const allowed = new Set(['text','name','modelId','speed','stability','speedRatio','pitch','loudnessRatio',
  'emotion','emotionScale','performancePrompt','explicitLanguage','explicitDialect']);

export function narrationArguments(voice, catalog, request, project) {
  if (!voice?.selected_by_user || !voice.provider || !voice.voiceId) throw Error('请先选择本期具体音色。');
  const match = catalog.voices?.find(v => v.provider === voice.provider && v.voiceId === voice.voiceId);
  if (!match || match.available === false || !match.supportedUses?.includes('tts')) throw Error('所选音色目前无法用于配音，请重新选择。');
  if (!request || typeof request.text !== 'string' || !request.text.trim()) throw Error('缺少正式旁白文本。');
  for (const field of Object.keys(request)) {
    if (!allowed.has(field)) throw Error('配音身份和工程由工作台指定，无法接受字段 '+field);
    if (!['name','text'].includes(field) && !match.capabilities?.supportedControls?.includes(field)) throw Error('当前音色不支持参数 '+field);
  }
  return {...request, provider:voice.provider, voiceId:voice.voiceId, projectId:project.projectId,timelineId:project.timelineId};
}

// A short-lived tool-only thread shares the installed ChatCut login and never starts a model turn.
export async function submitNarration({codex,cwd,voice,request,project,assertCurrent}) {
  const client=new AppServerConnection(codex,{cwd,timeoutMs:60000});
  try {
    await client.open(true);
    const {thread}=await client.send('thread/start',{cwd,ephemeral:true});
    const call=(tool,args)=>client.send('mcpServer/tool/call',{threadId:thread.id,server:'chatcut',tool,arguments:args});
    const list=await call('manage_voice',{action:'list',voiceType:voice.voiceType,use:'tts',locale:'zh'});
    if(list.isError)throw Error('音色目录查询失败，请检查 ChatCut 连接。');
    const catalog=list.structuredContent||JSON.parse(list.content.find(v=>v.type==='text').text);
    const args=narrationArguments(voice,catalog,request,project);
    await assertCurrent();
    // ChatCut deduplicates project + text + resolved voice + controls. Never mint a retry requestId.
    const result=await call('submit_voice',args);
    if(result.isError)throw Error('ChatCut 未确认配音提交；请先查询已有任务再继续。');
    return result;
  } finally {client.close();}
}
