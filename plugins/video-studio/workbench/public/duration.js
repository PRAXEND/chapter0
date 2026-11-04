export function validateDurationRange(maximum,minimum=null){
  if(!Number.isFinite(maximum)||maximum<3||maximum>1200)throw Error('时长上限需要为 3–1200 秒。');
  if(minimum!==null&&(!Number.isFinite(minimum)||minimum<3||minimum>1200))throw Error('最短时长需要为 3–1200 秒，或留空不设下限。');
  if(minimum!==null&&minimum>maximum)throw Error('最短时长不能超过时长上限。');
  return {duration:maximum,durationMin:minimum};
}
export function durationLabel(project){return project.durationMin==null?`${project.duration} 秒上限`:`${project.durationMin}–${project.duration} 秒`;}
