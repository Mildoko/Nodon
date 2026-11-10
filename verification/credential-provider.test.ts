import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSingleEnvVariable } from '../src/host/credential-provider.js';

const fake = 'synthetic-deepseek-parser-value-not-a-real-key';
test('credential parser extracts only the selected variable without evaluating shell text', () => {
  assert.equal(parseSingleEnvVariable('OTHER_SERVICE_KEY=unrelated\nexport DEEPSEEK_API_KEY=' + fake + ' # comment', 'DEEPSEEK_API_KEY'), fake);
  assert.equal(parseSingleEnvVariable("DEEPSEEK_API_KEY='" + fake + "'", 'DEEPSEEK_API_KEY'), fake);
  assert.equal(parseSingleEnvVariable('DEEPSEEK_API_KEY="' + fake + '"', 'DEEPSEEK_API_KEY'), fake);
  assert.equal(parseSingleEnvVariable('OTHER_SERVICE_KEY=' + fake, 'DEEPSEEK_API_KEY'), null);
  assert.equal(parseSingleEnvVariable('DEEPSEEK_API_KEY=', 'DEEPSEEK_API_KEY'), null);
});
test('credential parser rejects duplicate, interpolated and executable-looking values', () => {
  assert.throws(() => parseSingleEnvVariable('DEEPSEEK_API_KEY=' + fake + '\nDEEPSEEK_API_KEY=' + fake, 'DEEPSEEK_API_KEY'));
  for (const value of ['${OTHER_SERVICE_KEY}', '$(command)', '`command`', '"line\\nvalue"']) {
    assert.throws(() => parseSingleEnvVariable('DEEPSEEK_API_KEY=' + value, 'DEEPSEEK_API_KEY'));
  }
});
