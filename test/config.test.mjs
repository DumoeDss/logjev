import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, isAbsolute } from 'node:path';
import { loadConfig } from '../dist/config.js';

test('YAML settings, provider overrides, environment precedence, and invalid concurrency',async(t)=>{
  const dir=await mkdtemp(join(tmpdir(),'logjev-config-'));
  t.after(async()=>{const scope=relative(tmpdir(),dir);assert(!isAbsolute(scope)&&!scope.startsWith('..')&&scope.startsWith('logjev-config-'));await rm(dir,{recursive:true,force:true});});
  const path=join(dir,'config.yaml');
  const yaml='active: first\nglobals:\n  port: 8013\n  read_temperature: 1\n  concurrency: 3\n  retry_delays_ms: [1, 2]\nproviders:\n  first:\n    base_url: http://localhost:9001/v1\n    model: first-model\n  second:\n    base_url: http://localhost:9002/v1\n    model: second-model\n    api_key_env: FIXTURE_KEY\n    topk: 5\n';
  await writeFile(path,yaml);
  const cfg=loadConfig(path,{LOGJEV_ACTIVE:'second',OPENJEV_ACTIVE:'first',PORT:'9100',FIXTURE_KEY:'test-key',PROMPT_MODE:'minimal'});
  assert.equal(cfg.active,'second');assert.equal(cfg.port,9100);assert.equal(cfg.providers.second.apiKey,'test-key');assert.equal(cfg.providers.second.topk,5);assert.equal(cfg.promptMode,'minimal');assert.equal(cfg.concurrency,3);
  assert.equal(loadConfig(path,{OPENJEV_ACTIVE:'second'}).active,'second');
  await writeFile(path,yaml.replace('concurrency: 3','concurrency: 0'));
  assert.throws(()=>loadConfig(path,{}),/concurrency/);
});
