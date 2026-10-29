/* Apply before styles paint; appearance stays local to this browser. */
(() => {
  const key='frame-appearance',choices=['light','dark','system'];
  const root=document.documentElement;
  const system=window.matchMedia('(prefers-color-scheme: dark)');
  let preference='system';
  try{const saved=localStorage.getItem(key);if(choices.includes(saved))preference=saved;}catch{}
  function apply(){
    root.dataset.theme=preference==='system'?(system.matches?'dark':'light'):preference;
    root.dataset.appearance=preference;
    document.querySelectorAll('button[data-appearance]').forEach(button=>{
      button.setAttribute('aria-pressed',String(button.dataset.appearance===preference));
    });
  }
  apply();
  system.addEventListener('change',()=>{if(preference==='system')apply();});
  window.addEventListener('storage',event=>{
    if(event.key===key||event.key===null){preference=choices.includes(event.newValue)?event.newValue:'system';apply();}
  });
  document.addEventListener('DOMContentLoaded',()=>{
    apply();
    document.querySelectorAll('button[data-appearance]').forEach(button=>button.addEventListener('click',()=>{
      const next=button.dataset.appearance;if(!choices.includes(next))return;
      preference=next;try{localStorage.setItem(key,next);}catch{}
      apply();
    }));
  });
})();
