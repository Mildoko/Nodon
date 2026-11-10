import { readFileSync } from 'node:fs';
import { resolve, isAbsolute } from 'node:path';

/** Parse one authorized variable as data; never source a shell file or return other credentials. */
export function parseSingleEnvVariable(text: string, name: string): string | null {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error('E_CREDENTIAL_VARIABLE');
  let found: string | null = null;
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!match || match[1] !== name) continue;
    const raw = match[2] ?? '';
    let value: string;
    if (raw.startsWith("'")) {
      const quoted = /^'([^']*)'\s*(?:#.*)?$/.exec(raw);
      if (!quoted) throw new Error('E_CREDENTIAL_FORMAT');
      value = quoted[1] ?? '';
    } else if (raw.startsWith('"')) {
      const quoted = /^("(?:[^"\\]|\\.)*")\s*(?:#.*)?$/.exec(raw);
      if (!quoted?.[1]) throw new Error('E_CREDENTIAL_FORMAT');
      try { value = JSON.parse(quoted[1]) as string; } catch { throw new Error('E_CREDENTIAL_FORMAT'); }
    } else {
      const unquoted = /^([^\s#]*)\s*(?:#.*)?$/.exec(raw);
      if (!unquoted) throw new Error('E_CREDENTIAL_FORMAT');
      value = unquoted[1] ?? '';
    }
    if (value.includes('${') || value.includes('$(') || value.includes('`') || /[\r\n\0]/.test(value)) throw new Error('E_CREDENTIAL_FORMAT');
    if (found !== null) throw new Error('E_CREDENTIAL_DUPLICATE');
    found = value;
  }
  return found && found.length >= 16 && found.length <= 512 ? found : null;
}

/** Host-only callback. The ignored config contains a source path and variable name, never a key. */
export function loadDeepSeekCredentialProvider(root = process.cwd()): () => Promise<string | null> {
  let source: { sourceFile: string; variable: string };
  try {
    const input: unknown = JSON.parse(readFileSync(resolve(root, '.local/credential-source.json'), 'utf8'));
    if (input === null || typeof input !== 'object' || Array.isArray(input)) throw new Error();
    const item = input as Record<string, unknown>;
    if (Object.keys(item).sort().join(',') !== 'sourceFile,variable' || typeof item['sourceFile'] !== 'string' || !isAbsolute(item['sourceFile']) || item['variable'] !== 'DEEPSEEK_API_KEY') throw new Error();
    source = { sourceFile: item['sourceFile'], variable: item['variable'] };
  } catch { throw new Error('E_CREDENTIAL_SOURCE'); }
  return async (): Promise<string | null> => {
    try { return parseSingleEnvVariable(readFileSync(source.sourceFile, 'utf8'), source.variable); }
    catch { throw new Error('E_CREDENTIAL_UNAVAILABLE'); }
  };
}
