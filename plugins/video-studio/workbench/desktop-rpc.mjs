import {spawn} from 'node:child_process';

// A private stdio connection. DesktopReader below exposes history reads only.
export class AppServerConnection {
  constructor(codex,{cwd,timeoutMs=15000}={}){this.codex=codex;this.cwd=cwd;this.timeoutMs=timeoutMs;this.sequence=0;this.pending=new Map();}
  async open(experimental=false){
    if(this.ready)return this.ready;
    this.ready=(async()=>{
      const child=this.child=spawn(this.codex,['app-server','--listen','stdio://'],{cwd:this.cwd,stdio:['pipe','pipe','pipe']});
      let buffer='';child.stderr.on('data',()=>{});child.stdin.on('error',()=>{});
      const fail=()=>{if(this.child!==child)return;for(const entry of this.pending.values()){clearTimeout(entry.timer);entry.reject(Error('本地 Codex 接口连接中断。'));}this.pending.clear();this.child=null;this.ready=null;};
      child.on('error',fail);child.on('close',fail);
      child.stdout.setEncoding('utf8');child.stdout.on('data',chunk=>{
        buffer+=chunk;if(buffer.length>32*1024*1024){child.kill();return;}
        let end;while((end=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,end);buffer=buffer.slice(end+1);let reply;try{reply=JSON.parse(line);}catch{continue;}
          const entry=this.pending.get(reply.id);if(!entry)continue;this.pending.delete(reply.id);clearTimeout(entry.timer);
          reply.error?entry.reject(Error(reply.error.message||'桌面历史接口不可用，请更新 Codex。')):entry.resolve(reply.result);
        }
      });
      const result=await this.send('initialize',{clientInfo:{name:'video_studio',version:'0.3.0'},capabilities:{experimentalApi:experimental}});
      child.stdin.write(JSON.stringify({method:'initialized',params:{}})+'\n');this.codexHome=result.codexHome;return this;
    })();
    return this.ready;
  }
  send(method,params){return new Promise((resolve,reject)=>{const id=++this.sequence,timer=setTimeout(()=>{this.pending.delete(id);reject(Error('本地 Codex 接口等待超时；请先查询已有任务。'));},this.timeoutMs);this.pending.set(id,{resolve,reject,timer});this.child.stdin.write(JSON.stringify({id,method,params})+'\n');});}
  close(){this.child?.kill();}
}

export class DesktopReader extends AppServerConnection {
  async call(method,params){if(!['thread/list','thread/read','thread/turns/list','thread/items/list'].includes(method))throw Error('仅允许读取桌面会话');await this.open();return this.send(method,params);}
}
