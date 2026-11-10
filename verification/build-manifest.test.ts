import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { createBuildIdentity, verifyFrozenInputs, collectRuntimeArtifactManifest } from '../tools/build-manifest.js';

function independentCanonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(independentCanonical).join(',') + ']';
  if (value !== null && typeof value === 'object') {
    const object = value as Record<string, unknown>;
    return '{' + Object.keys(object).sort().map(key => JSON.stringify(key) + ':' + independentCanonical(object[key])).join(',') + '}';
  }
  const text = JSON.stringify(value);
  if (text === undefined) throw new Error('Not JSON');
  return text;
}
const sha = (value: string | Uint8Array): string => 'sha256:' + createHash('sha256').update(value).digest('hex');
function compiledFiles(path = 'dist/src'): string[] {
  return readdirSync(resolve(path), { withFileTypes: true }).flatMap(entry => entry.isDirectory()
    ? compiledFiles(path + '/' + entry.name)
    : entry.isFile() && entry.name.endsWith('.js') ? [path + '/' + entry.name] : []);
}

test('actual root still matches all independently frozen T00 inputs', () => {
  assert.doesNotThrow(() => verifyFrozenInputs());
});

test('build identity hashes exactly the persisted manifest and actual executable closure', () => {
  const result = createBuildIdentity();
  assert.equal(result.buildHash, sha(independentCanonical(result.manifest)));
  assert.equal(result.runtimeArtifactHash, sha(independentCanonical(result.runtimeArtifactManifest)));
  assert.deepEqual(Object.keys(result.runtimeArtifactManifest).sort(), ['coreModuleFiles', 'runtimeDependencyFiles', 'runtimeDependencyPackages']);
  assert.deepEqual(Object.keys(result.manifest).sort(), ['manifestVersion','sourceRevision','sourceDirty','sourceFiles','lockfileHash','toolchain','contractHash','trustedConfigHashes','fixtureManifestHash','inputCatalogHash','capabilityHash','adapterCatalogHash','runtimeArtifactManifest','runtimeArtifactHash'].sort());
  assert.equal(result.buildId, result.buildHash.slice(7, 19));
  const allExecutableFiles = [...result.runtimeArtifactManifest.coreModuleFiles, ...result.runtimeArtifactManifest.runtimeDependencyFiles];
  const included = new Map([...allExecutableFiles, ...(result.manifest['sourceFiles'] as {path:string;byteLength:number;sha256:string}[])].map(file => [file.path, file]));
  for (const path of compiledFiles()) {
    assert.ok(included.has(path), 'compiled module omitted: ' + path);
  }
  for (const file of allExecutableFiles) {
    const bytes = readFileSync(resolve(file.path));
    assert.equal(sha(bytes), file.sha256, file.path);
    assert.equal(bytes.byteLength, file.byteLength, file.path);
  }
  for (const pkg of result.runtimeArtifactManifest.runtimeDependencyPackages) {
    const installed = JSON.parse(readFileSync(resolve(pkg.packageRoot, 'package.json'), 'utf8')) as {name:string;version:string};
    assert.equal(pkg.name, installed.name); assert.equal(pkg.version, installed.version);
  }
  assert.ok(result.runtimeArtifactManifest.coreModuleFiles.every(file => /^dist\/src\/(domain|runtime)\//.test(file.path)));
  assert.ok(result.productionPackagePaths.includes('node_modules/ajv'));
  assert.ok(!result.productionPackagePaths.includes('node_modules/typescript'));
  assert.ok(!result.productionPackagePaths.includes('node_modules/@types/node'));
  const again = createBuildIdentity();
  assert.equal(again.buildHash, result.buildHash, 'same files and environment must have stable identity');
});


test('D12 collector binds actual dependency bytes and excludes uncompiled source edits', () => {
  const root = mkdtempSync(join(tmpdir(), 'nodon-artifact-unit-'));
  try {
    mkdirSync(join(root, 'dist/src/domain'), {recursive:true});
    mkdirSync(join(root, 'node_modules/ajv'), {recursive:true});
    mkdirSync(join(root, 'src/domain'), {recursive:true});
    writeFileSync(join(root, 'package-lock.json'), JSON.stringify({packages:{'':{},'node_modules/ajv':{version:'8.20.0'}}}));
    writeFileSync(join(root, 'node_modules/ajv/package.json'), JSON.stringify({name:'ajv',version:'8.20.0'}));
    writeFileSync(join(root, 'node_modules/ajv/index.js'), 'module.exports=1;');
    writeFileSync(join(root, 'dist/src/domain/index.js'), 'export const value=1;');
    const first = sha(independentCanonical(collectRuntimeArtifactManifest(root)));
    writeFileSync(join(root, 'src/domain/index.ts'), 'export const value=999;');
    assert.equal(sha(independentCanonical(collectRuntimeArtifactManifest(root))), first, 'uncompiled source is not executable bytes');
    writeFileSync(join(root, 'node_modules/ajv/index.js'), 'module.exports=2;');
    assert.notEqual(sha(independentCanonical(collectRuntimeArtifactManifest(root))), first, 'changed installed dependency must invalidate artifact');
  } finally { rmSync(root, {recursive:true, force:true}); }
});
