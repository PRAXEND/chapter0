import {ensureWorkbench} from '../workbench/launcher.mjs';

try {
  if(Number(process.versions.node.split('.')[0])<20)throw new Error('请先安装 Node.js 20 或更新版本。');
  const result=await ensureWorkbench();
  console.log(JSON.stringify({ok:true,...result}));
} catch(error) {
  console.error(JSON.stringify({ok:false,error:error.message}));process.exitCode=1;
}
