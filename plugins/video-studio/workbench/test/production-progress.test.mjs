import test from 'node:test';
import assert from 'node:assert/strict';
import {acceptProductionProgress,toolFailure,connectionIssue} from '../production-progress.mjs';
const job={id:'new',startedAt:'2026-11-03T00:00:00Z'},now=Date.parse(job.startedAt);
test('a resumed task never displays an old attempt as current editing',()=>{
 assert.equal(acceptProductionProgress({stage:'editing'},job,now-1),false);
 assert.equal(acceptProductionProgress({stage:'editing',jobId:'old'},job,now+1),false);
 assert.equal(acceptProductionProgress({stage:'preparing',jobId:'new'},job,now+1),true);
 assert.equal(acceptProductionProgress({stage:'importing'},job,now+1),true);
 assert.equal(acceptProductionProgress({stage:'exported'},job,now+1),false);
});
test('MCP error payloads are not shown as successful operations',()=>{
 const message='No browser executor is connected';
 assert.equal(toolFailure({status:'completed',result:{isError:true,content:[{type:'text',text:message}]}}),message);
 assert.equal(connectionIssue(message),true);
 assert.equal(toolFailure({status:'failed',error:{message:'permission denied'}}),'permission denied');
 assert.equal(connectionIssue('permission denied'),false);
 assert.equal(toolFailure({status:'completed',result:{isError:false,content:[{type:'text',text:'connected'}]}}),'');
});

import {normalizeDownloadRequest} from '../production-progress.mjs';
test('only an explicit pending download gets the saved-file handoff',()=>{
 const result={status:'needs_input',downloadRequest:{renderId:'render-1',expectedFilename:'review.mp4',purpose:'review'}};
 assert.deepEqual(normalizeDownloadRequest(result),result.downloadRequest);
 assert.equal(normalizeDownloadRequest({...result,status:'exported'}),null);
 assert.equal(normalizeDownloadRequest({...result,downloadRequest:{...result.downloadRequest,expectedFilename:'../review.mp4'}}),null);
 assert.equal(normalizeDownloadRequest({status:'needs_input'}),null);
});
