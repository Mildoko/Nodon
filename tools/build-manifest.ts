import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, realpathSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, relative, sep, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { canonicalJson } from '../src/domain/index.js';

export interface FileDigest { path: string; byteLength: number; sha256: string }
export interface RuntimeArtifactManifest {
  coreModuleFiles: FileDigest[]; runtimeDependencyPackages: { name: string; version: string; packageRoot: string }[]; runtimeDependencyFiles: FileDigest[];
}
export interface BuildIdentity {
  buildHash: string; runtimeArtifactHash: string; buildId: string; environmentId: string;
  manifest: Record<string, unknown>; runtimeArtifactManifest: RuntimeArtifactManifest; productionPackagePaths: string[];
}
export function digest(bytes: string | Uint8Array): string { return 'sha256:' + createHash('sha256').update(bytes).digest('hex'); }
function json(path: string): Record<string, unknown> { return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>; }
function walk(root: string, folder: string): string[] {
  const abs = resolve(root, folder);
  if (!existsSync(abs)) return [];
  return readdirSync(abs, { withFileTypes: true }).flatMap(entry => {
    const rel = relative(root, resolve(abs, entry.name)).split(sep).join('/');
    if (entry.isSymbolicLink()) throw new Error('Build closure cannot silently follow symlink: ' + rel);
    return entry.isDirectory() ? walk(root, rel) : entry.isFile() ? [rel] : [];
  }).sort();
}
function files(root: string, paths: string[]): FileDigest[] {
  return [...new Set(paths)].sort().map(path => {
    const data = readFileSync(resolve(root, path));
    return { path, byteLength: data.byteLength, sha256: digest(data) };
  });
}
function listHash(value: unknown): string { return digest(canonicalJson(value)); }
export function verifyFrozenInputs(root = process.cwd()): void {
  const freeze = json(resolve(root, 'docs/t00-freeze-manifest.json'));
  const items = freeze['files'] as FileDigest[];
  for (const item of items) {
    const actual = readFileSync(resolve(root, item.path));
    if (actual.byteLength !== item.byteLength || digest(actual).slice(7) !== item.sha256) throw new Error('Frozen input changed: ' + item.path);
  }
  if (listHash(items) !== freeze['freezeHash']) throw new Error('T00 freeze-list hash mismatch');
}
/** File-collector unit is separately testable on synthetic directories; execution stays unique-root gated. */
export function collectRuntimeArtifactManifest(root: string): RuntimeArtifactManifest {
  const lock = json(resolve(root, 'package-lock.json'));
  const packages = lock['packages'] as Record<string, { dev?: boolean; version?: string }>;
  const productionPaths = Object.entries(packages).filter(([path, info]) => path !== '' && !info.dev).map(([path]) => path).sort();
  const corePaths = [...walk(root, 'dist/src/domain'), ...walk(root, 'dist/src/runtime')].filter(path => path.endsWith('.js'));
  if (corePaths.length === 0) throw new Error('No actual compiled Runtime/domain modules');
  const runtimeDependencyPackages = productionPaths.map(packageRoot => {
    const installed = json(resolve(root, packageRoot, 'package.json'));
    const name = installed['name']; const version = installed['version'];
    if (typeof name !== 'string' || typeof version !== 'string' || version !== packages[packageRoot]?.version) throw new Error('Installed dependency differs from lock: ' + packageRoot);
    return { name, version, packageRoot };
  });
  return { coreModuleFiles: files(root, corePaths), runtimeDependencyPackages, runtimeDependencyFiles: files(root, productionPaths.flatMap(path => walk(root, path))) };
}
export function createBuildIdentity(root = process.cwd()): BuildIdentity {
  const environment = json(resolve(root, 'docs/r0-environment.json'));
  if (realpathSync(root) !== realpathSync(String(environment['codeRoot']))) throw new Error('Execute only in the authorized unique code root');
  if (process.versions.node !== environment['nodeVersion']) throw new Error('Node executable version differs from frozen environment');
  if (digest(readFileSync(process.execPath)).slice(7) !== environment['nodeExecutableSha256']) throw new Error('Node executable bytes differ from frozen environment');
  verifyFrozenInputs(root);
  const runtimeArtifactManifest = collectRuntimeArtifactManifest(root);
  const productionPackagePaths = runtimeArtifactManifest.runtimeDependencyPackages.map(pkg => pkg.packageRoot);
  const runtimeArtifactHash = listHash(runtimeArtifactManifest);
  let sourceRevision: string | null = null;
  try { sourceRevision = execFileSync('git', ['rev-parse', '--verify', 'HEAD'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { /* new repository has no commit */ }
  const sourceDirty = execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).length > 0;
  const sourceFiles = files(root, [...['src', 'tools', 'verification'].flatMap(path => walk(root, path)).filter(path => /\.(ts|js|html|css|json)$/.test(path)), ...walk(root, 'dist').filter(path => path.endsWith('.js') && !path.startsWith('dist/src/domain/') && !path.startsWith('dist/src/runtime/'))]);
  const fixtureFiles = files(root, ['verification/case-manifest.json', 'verification/fixture-hash-vectors.json', ...walk(root, 'verification/fixtures')]);
  const inputFiles = files(root, walk(root, 'verification/inputs'));
  const contractFiles = files(root, ['docs/r0-runtime-contract.md', 'docs/r0-motion-evidence-adr.md', 'docs/r0-t00-decisions.md', 'docs/t00-freeze-manifest.json', 'docs/r0-web-contract.md', 'docs/r0-t05-candidate-contract.md'].filter(path => existsSync(resolve(root, path))));
  const trustedConfigHashes = files(root, walk(root, 'config'));
  const capabilities = { capabilityVersion: 'nodon-r0-capabilities@1', operations: ['set_goal', 'set_reward_values', 'set_guard_speed', 'set_detect_radius', 'set_timer', 'move_entity', 'set_theme'], batchMin: 1, batchMax: 3 };
  const manifest: Record<string, unknown> = {
    manifestVersion: 'nodon-r0-build@1', sourceRevision, sourceDirty, sourceFiles,
    lockfileHash: digest(readFileSync(resolve(root, 'package-lock.json'))),
    toolchain: { node: process.versions.node, npm: environment['npmVersion'], typescript: environment['typescriptVersion'], ajv: environment['ajvVersion'], nodeTypes: environment['nodeTypesVersion'], nodeExecutableSha256: environment['nodeExecutableSha256'] },
    contractHash: listHash(contractFiles), trustedConfigHashes,
    fixtureManifestHash: listHash(fixtureFiles), inputCatalogHash: listHash(inputFiles),
    capabilityHash: listHash(capabilities), adapterCatalogHash: digest(readFileSync(resolve(root, 'config/catalog.json'))), runtimeArtifactManifest, runtimeArtifactHash,
  };
  const buildHash = listHash(manifest);
  return { buildHash, runtimeArtifactHash, buildId: buildHash.slice(7, 19), environmentId: String(environment['environmentId']), manifest, runtimeArtifactManifest, productionPackagePaths };
}
export function persistBuildIdentity(identity: BuildIdentity, root = process.cwd()): string {
  const path = resolve(root, 'evidence/r0', identity.buildId, '00_manifest/build.json');
  const output = { ...identity, manifest: identity.manifest };
  if (existsSync(path)) {
    const old = json(path);
    if (old['buildHash'] !== identity.buildHash) throw new Error('Build ID prefix collision');
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(output, null, 2) + '\n');
  return path;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const identity = createBuildIdentity();
  const manifestPath = persistBuildIdentity(identity);
  console.log(JSON.stringify({ buildId: identity.buildId, buildHash: identity.buildHash, runtimeArtifactHash: identity.runtimeArtifactHash, manifestPath }));
}
