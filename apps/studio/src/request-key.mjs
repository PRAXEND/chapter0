import {createHash} from 'node:crypto';

// The input consists of JSON from the local API. Object key order does not change an intent.
export function intentHash(value){
  const sorted=(_,v)=>v&&typeof v==='object'&&!Array.isArray(v)
    ?Object.fromEntries(Object.keys(v).sort().map(k=>[k,v[k]])):v;
  return createHash('sha256').update(JSON.stringify(value,sorted)).digest('hex');
}
export const validRequestId=id=>typeof id==='string'&&/^[A-Za-z0-9-]{8,80}$/.test(id);
