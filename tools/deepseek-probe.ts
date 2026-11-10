import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseDocument, parseStrictJson, canonicalJson } from '../src/domain/index.js';
import { assertAuthorizedRoot } from '../src/evidence/run-evidence.js';
import { CommandQueue } from '../src/host/command-queue.js';
import { loadDeepSeekCredentialProvider } from '../src/host/credential-provider.js';
import { AiAuthority, AiGateway, AiLedger, AiError, type SubmitRequest, type GatewayResult } from '../src/ai/index.js';
import type { FrozenRequestManifest } from '../src/ai/ledger.js';
import { buildBody, validateAccess, validateRequest } from '../src/ai/protocol.js';
import { createBuildIdentity, persistBuildIdentity } from './build-manifest.js';

interface ProbeManifest extends FrozenRequestManifest {
  slots: (FrozenRequestManifest['slots'][number] & { intent: string; inputFixturePath: string })[];
}

async function main(): Promise<void> {
  const mode = process.argv[2];
  if (mode !== '--prepare' && mode !== '--send') throw new Error('E_EXPLICIT_PROBE_MODE_REQUIRED');
  const root = assertAuthorizedRoot(); const identity = createBuildIdentity(root);
  const access = validateAccess(parseStrictJson(readFileSync(resolve(root, 'config/deepseek-access.json'), 'utf8')));
  const manifest = parseStrictJson(readFileSync(resolve(root, 'verification/model-request-manifest.json'), 'utf8')) as ProbeManifest;
  const slot = manifest.slots.find(item => item.requestSlotID === 'PROBE-ACCESS');
  if (!slot || slot.inputFixturePath !== 'verification/fixtures/scene-b.json') throw new Error('E_PROBE_SLOT');
  const document = parseDocument(readFileSync(resolve(root, slot.inputFixturePath), 'utf8'));
  const privateRoot = resolve(root, '.local/ai'); mkdirSync(privateRoot, {recursive:true, mode:0o700});
  const seedPath = resolve(privateRoot, 'access-request.json');
  let request: SubmitRequest;
  if (existsSync(seedPath)) request = validateRequest(parseStrictJson(readFileSync(seedPath, 'utf8')));
  else {
    const requestId = randomUUID();
    request = {requestSlotID:'PROBE-ACCESS',requestId,idempotencyKey:randomUUID(),document,
      snapshot:{projectId:document.project.projectId,requestId,baseRevision:document.project.revision,baseSemanticHash:document.project.semanticHash,
        runtimeVersion:'collect-chase@1',catalogVersion:'workshop-core@1',ruleRegistryVersion:'collect-chase-rules@1',trialPolicyVersion:'collect-chase-candidate-trial@2',
        capabilityVersion:'nodon-r0-capabilities@1',authEpoch:0,sessionId:'r0-access-probe',writerToken:randomUUID(),requestText:slot.intent,selectedEvidenceRefs:[]}};
    writeFileSync(seedPath, JSON.stringify(request,null,2)+'\n', {flag:'wx',mode:0o600});
  }
  if (request.requestSlotID !== 'PROBE-ACCESS' || request.snapshot.requestText !== slot.intent || canonicalJson(request.document) !== canonicalJson(document)) throw new Error('E_PROBE_FROZEN_INPUT');
  const body = buildBody(request);
  const directory = resolve(root, 'evidence/r0', identity.buildId, '07_ai/access'); mkdirSync(directory,{recursive:true});
  persistBuildIdentity(identity,root);
  writeFileSync(resolve(directory,'outbound-preview.json'), body+'\n');
  writeFileSync(resolve(directory,'approved-profile.json'),JSON.stringify({access,userApproval:'2026-10-28 DeepSeek-V4.1-Flash-1017 total <=20 CNY',
    officialMappingChecked:'2026-10-28',sources:['https://api-docs.deepseek.com/zh-cn/','https://api-docs.deepseek.com/zh-cn/quick_start/pricing/'],
    requestSlotID:'PROBE-ACCESS',fixture:slot.inputFixturePath,intent:slot.intent,credential:'existing local DeepSeek variable; no secret copied'},null,2)+'\n');
  if (mode === '--prepare') {
    console.log(JSON.stringify({mode:'prepared_no_network_no_credential_read',buildId:identity.buildId,preview:resolve(directory,'outbound-preview.json'),
      serializedBodyBytes:Buffer.byteLength(body),requestSlotID:'PROBE-ACCESS',inputUpperBound:Buffer.byteLength(body)+1024,reservationCNY:0.056768})); return;
  }
  const queue = new CommandQueue();
  const ledger = new AiLedger(queue,resolve(privateRoot,'r0-ledger.sqlite'),manifest);
  let gateway: AiGateway | null = null;
  try {
    if (ledger.attempts(request.requestId).length > 0) {
      console.log(JSON.stringify({status:'previous_attempt_present_no_network',result:ledger.result(request.requestId),budget:ledger.budget()})); return;
    }
    const authority = new AiAuthority(queue,{authEpoch:request.snapshot.authEpoch,adultEnabled:true,sessionId:request.snapshot.sessionId,
      writerToken:request.snapshot.writerToken,projectId:document.project.projectId,scopeEnabled:true});
    gateway = new AiGateway(authority,ledger,access,loadDeepSeekCredentialProvider(root));
    const result: GatewayResult = await gateway.submit(request);
    const returnedModel = 'attempt' in result ? result.attempt?.returnedModel ?? null : null;
    const modelMappingConsistent = returnedModel !== null && ['deepseek-flash','deepseek-v4.1-flash-1017'].includes(returnedModel.toLowerCase());
    const readOnlyResponse = result.status === 'answered' && result.response.kind !== 'propose';
    const report = {taskId:'R0-T06',source:'real_provider_probe',requestSlotID:'PROBE-ACCESS',buildId:identity.buildId,buildHash:identity.buildHash,
      runtimeArtifactHash:identity.runtimeArtifactHash,requestedProductModel:access.productModel,apiModel:access.model,returnedModel,modelMappingConsistent,
      readOnlyResponse,result,budget:ledger.budget(),billing:'usage-derived peak estimate; supplier bill not independently settled',
      limitations:['not a real creation/diagnosis chain','no Store write or candidate commit','human semantic judgment not supplied','rolling alias mapped by official documentation at execution time']};
    writeFileSync(resolve(directory,'access-result.json'),JSON.stringify(report,null,2)+'\n');
    console.log(JSON.stringify({status:result.status,buildId:identity.buildId,returnedModel,modelMappingConsistent,readOnlyResponse,
      attempts:ledger.budget().attempts,resultPath:resolve(directory,'access-result.json'),reservedCNY:ledger.budget().reservedNanoCNY/1e9}));
    if (result.status !== 'answered' || !modelMappingConsistent || !readOnlyResponse) process.exitCode = 1;
  } finally { if(gateway) await gateway.shutdown(); ledger.close(); }
}
void main().catch(error => {console.error(JSON.stringify({error:error instanceof AiError ? error.code : 'E_ACCESS_PROBE',secretPrinted:false}));process.exitCode=1;});
