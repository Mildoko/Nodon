import test from 'node:test';
import assert from 'node:assert/strict';
import { createWebServer } from '../src/host/web-server.js';
import type { BuildIdentity } from '../tools/build-manifest.js';
const identity:BuildIdentity={buildId:'synthetic-r0-entry',buildHash:'sha256:'+'c'.repeat(64),runtimeArtifactHash:'sha256:'+'d'.repeat(64),environmentId:'synthetic',manifest:{},runtimeArtifactManifest:{coreModuleFiles:[],runtimeDependencyPackages:[],runtimeDependencyFiles:[]},productionPackagePaths:[]};
test('R0 entry: default mode rejects every real-provider control before reading credentials or sending',async()=>{
 const app=createWebServer({root:process.cwd(),buildIdentity:identity,port:0}); const {url}=await app.listen();
 try {const session=await(await fetch(url+'/api/session')).json() as {connectionId:string;csrfToken:string};
  for(const [path,body] of [['/api/real-ai/request',{eventIds:[]}],['/api/real-ai/retry',{}],['/api/real-ai/cancel',{}],['/api/real-ai/frozen-run',{}],['/api/real-ai/recheck',{}],['/api/real-ai/advance-child',{}],['/api/real-ai/dispose-child',{reason:'parent_no_eligible_options'}],['/api/real-ai/decision',{decision:'accept',semantic:'correct',rationale:'synthetic'}]] as const){
   const r=await fetch(url+path,{method:'POST',headers:{Origin:url,'Content-Type':'application/json','X-Nodon-Connection':session.connectionId,'X-Nodon-CSRF':session.csrfToken},body:JSON.stringify(body)}); const data=await r.json() as {ok:boolean;error:string};assert.equal(data.ok,false);assert.equal(data.error,'E_REAL_AI_DISABLED');
  }
 } finally{await app.close();}
});
test('R0 entry: browser cannot self-assert a human source, default is machine; host-configured human mode remains declared evidence',async()=>{
 for(const human of [false,true]){const app=createWebServer({root:process.cwd(),buildIdentity:identity,port:0,...(human?{humanParticipant:'HUMAN-01' as const}:{})});const {url}=await app.listen();
 try{const s=await(await fetch(url+'/api/session')).json() as {connectionId:string;csrfToken:string;snapshot:{inputSource:string;executionClass:string}};
  assert.equal(s.snapshot.inputSource,human?'human_keyboard':'machine_browser_input');assert.equal(s.snapshot.executionClass,human?'human_operation':'automation_test');
  const r=await fetch(url+'/api/focus',{method:'POST',headers:{Origin:url,'Content-Type':'application/json','X-Nodon-Connection':s.connectionId,'X-Nodon-CSRF':s.csrfToken},body:JSON.stringify({focused:true,inputSource:'human_keyboard'})});assert.equal((await r.json() as {error:string}).error,'E_FIELDS');
 }finally{await app.close();}}
});
test('R0 entry: frozen mirrors are host-whitelisted and never arbitrary paths',()=>{assert.throws(()=>createWebServer({root:process.cwd(),buildIdentity:identity,initialFixtureId:'../../secret' as never}),/E_FROZEN_FIXTURE/);});
