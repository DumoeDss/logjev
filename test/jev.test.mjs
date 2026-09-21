import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { normalizeQuestion, buildPrompt, answerFor, parseTopLogprobs, QuestionError } from '../dist/index.js';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/golden.json', import.meta.url), 'utf8'));
test('Python golden prompts, labels, distributions and sentinel parsing', () => {
  for (const [i, item] of fixture.cases.entries()) {
    const q = normalizeQuestion('q', item.raw);
    assert.deepEqual(buildPrompt(item.state, q, item.history, item.mode, item.firm), [item.messages, item.labels], `prompt case ${i}`);
    for (const { top, answer } of item.answers) assert.deepEqual(answerFor(q, item.labels, top), answer, `answer case ${i}`);
  }
  for (const { choice, expected } of fixture.parse) assert.deepEqual(JSON.parse(JSON.stringify(parseTopLogprobs(choice))), expected);
  for (const item of fixture.rounding) assert.deepEqual(answerFor(normalizeQuestion('q',item.raw),item.labels,item.top),item.answer);
});
test('reject invalid questions before making any upstream call', () => {
  for (const raw of [null, [], {}, {type:'other',instructions:'x'}, {type:'noul',instructions:' '}, {type:'choice',instructions:'x',criteria:{}}, {type:'score',instructions:'x',criteria:['only']}, {type:'choice',instructions:'x',criteria:Object.fromEntries(Array.from({length:49},(_,i)=>[String(i),'']))}]) {
    assert.throws(() => normalizeQuestion('q',raw), QuestionError);
  }
});
test('sentinels, non-finite values and prototype-looking labels are safe', () => {
  const choice = {logprobs:{content:[{top_logprobs:[{token:'A',logprob:Infinity},{token:'B',logprob:NaN},{token:'__proto__',logprob:-.2}]}]}};
  const top = parseTopLogprobs(choice);
  assert.deepEqual(Object.keys(top), ['__proto__']);
  assert.equal(top.__proto__, -.2);
});
