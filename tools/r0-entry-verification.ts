import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { parseDocument, parseStrictJson } from '../src/domain/index.js';
import { R0Host } from '../src/host/r0-host.js';
import { createBuildIdentity, persistBuildIdentity } from './build-manifest.js';
import { assertAuthorizedRoot } from '../src/evidence/run-evidence.js';
const root = assertAuthorizedRoot(), build = createBuildIdentity(root);
persistBuildIdentity(build, root);
async function execute(fixture: string, inputRef: string, expectedTicks: number, expectedReason: string | null) {
 const host = new R0Host(parseDocument(readFileSync(resolve(root, fixture),'utf8')),{sessionId:randomUUID(),writerToken:randomUUID(),buildIdentity:build});
 await host.startRun({evidenceSource:'machine_test',inputSource:'catalog_machine',executionClass:'automation_test'});
 const input = parseStrictJson(readFileSync(resolve(root,inputRef),'utf8')) as {segments:{ticks:number;x:-1|0|1;y:-1|0|1}[]};
 const startedAt=new Date().toISOString();const start=performance.now();const samples:unknown[]=[];
 samples.push({actualTick:0,wallElapsedMs:0});
 for (const segment of input.segments) {
  for(let i=0;i<segment.ticks;i++){
   const before=host.currentRun()!;if(before.status!=='running')break;
   const after=await host.input({runId:before.context.runId,generation:before.context.generation,direction:{x:segment.x,y:segment.y}});
   if([600,900,1800,3600,6000,6600].includes(after.tick))samples.push({actualTick:after.tick,wallElapsedMs:performance.now()-start,status:after.status,score:after.score});
   if(after.tick%60===0)await setImmediate();
  }
 }
 const result=host.currentRun()!;assert.equal(result.tick,expectedTicks);assert.equal(result.terminal?.reason??null,expectedReason);assert.equal(result.diagnostics.length,0);assert.equal(result.budgetExhausted,false);
 if(expectedReason==='caught'){assert.equal(result.score,1);assert.equal(result.terminal?.goalReached,true);assert.equal(result.terminal?.caught,true);assert.equal(result.terminal?.timeout,true);assert.equal(result.events.filter(e=>e.kind==='round_ended').length,1);}
 else {assert.equal(result.score,0);await host.pause();}
 const run=host.currentRun()!;
 const runPath=await host.exportCurrentRun({root,fixtureRef:fixture,inputRef,assertions:{caseId:expectedReason?'R0-RT-07-caught':'R0-ENTRY-NODE-LONG-6600',actualExecution:'Node catalog Runtime, not browser or human',expectedTicks,actualTick:run.tick,expectedReason,actualReason:run.terminal?.reason??null,diagnostics:run.diagnostics.length,budgetExhausted:run.budgetExhausted,samples}});
 return {runId:run.context.runId,runPath,startedAt,completedAt:new Date().toISOString(),wallExecutionMs:performance.now()-start,tick:run.tick,status:run.status,score:run.score,reason:run.terminal?.reason??null,samples};
}
const records=[];
records.push(await execute('verification/fixtures/terminal-conflict.json','verification/inputs/terminal-conflict.json',900,'caught'));
records.push(await execute('verification/fixtures/scene-b.json','verification/inputs/entry-idle-6600.json',6600,null));
const dir=resolve(root,'evidence/r0',build.buildId,'10_decisions');mkdirSync(dir,{recursive:true});
const path=resolve(dir,'entry-runtime-'+randomUUID()+'.json');
writeFileSync(path,JSON.stringify({kind:'actual_node_runtime_program_evidence',buildId:build.buildId,buildHash:build.buildHash,runtimeArtifactHash:build.runtimeArtifactHash,records,providerCalls:0,credentialsRead:false,humanPerformed:false,browserPerformed:false,limitation:'Node catalog 6600 actual ticks do not prove browser wall-clock performance, first-key delivery, author understanding or full AI chains'},null,2)+String.fromCharCode(10),{flag:'wx'});
console.log(JSON.stringify({status:'passed_program_runtime_only',buildId:build.buildId,reportPath:path,records}));
