import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBridge } from '../dist/index.js';

const config = { active: 'chat', providers: {
  chat: { name: 'chat', kind: 'chat', baseUrl: 'http://upstream.test/v1', model: 'fixture', topk: 5 },
  official: { name: 'official', kind: 'jev', baseUrl: 'http://upstream.test/decisions', model: 'jev' },
}, retryDelaysMs: [] };
const q = { type: 'choice', instructions: 'Classify the audio.', criteria: { refund: 'Refund', other: 'Other' } };
const history = [{ role: 'user', content: [
  { type: 'text', text: 'Listen to this recording.' },
  { type: 'image_url', image_url: { url: 'data:image/png;base64,AA==' } },
  { type: 'input_audio', input_audio: { data: 'UklGRg==', format: 'wav' } },
  { type: 'audio_url', audio_url: { url: 'data:audio/wav;base64,UklGRg==' } },
] }];
const request = body => new Request('http://bridge.test/v1/systemone', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const upstream = (top = [{ token: ' A', logprob: -.2 }, { token: 'B', logprob: -2 }]) => Response.json({ choices: [{ logprobs: { content: [{ top_logprobs: top }] } }] });

test('audio and mixed history survive each question in both prompt modes', async () => {
  for (const prompt_mode of ['full', 'minimal']) {
    const calls = [];
    const bridge = createBridge(config, { fetch: async (_url, init) => { calls.push(JSON.parse(init.body)); return upstream(); } });
    const response = await bridge(request({ messages: history, prompt_mode, questions: { a: q, b: q } }));
    assert.equal(response.status, 200);
    assert.equal((await response.json()).answers.a.choice, 'refund');
    assert.equal(calls.length, 2);
    for (const body of calls) {
      assert.deepEqual(body.messages.slice(0, -1), history);
      assert.equal(typeof body.messages.at(-1).content, 'string');
      assert.deepEqual([body.max_tokens, body.temperature, body.top_logprobs, body.logprobs], [1, 1, 5, true]);
    }
  }
});

test('audio survives missing-logprobs and firm-prompt retries', async () => {
  const calls = [];
  const bridge = createBridge(config, { fetch: async (_url, init) => {
    calls.push(JSON.parse(init.body));
    return calls.length === 1 ? Response.json({ choices: [{ message: { content: 'A' } }] })
      : calls.length === 2 ? upstream([{ token: 'unrelated', logprob: -1 }]) : upstream();
  } });
  assert.equal((await bridge(request({ messages: history, questions: { q } }))).status, 200);
  assert.equal(calls.length, 3);
  for (const body of calls) assert.deepEqual(body.messages.slice(0, -1), history);
  assert.match(calls.at(-1).messages.at(-1).content, /Answer immediately/);
});

test('malformed audio fails before any upstream request', async () => {
  let calls = 0;
  const bridge = createBridge(config, { fetch: async () => { calls++; return upstream(); } });
  for (const input_audio of [null, [], 'wav', {}, { data: 'AA==' }, { format: 'wav' }, { data: 1, format: 'wav' }, { data: 'AA==', format: 1 }, { data: '  ', format: 'wav' }, { data: 'AA==', format: ' ' }]) {
    const response = await bridge(request({ messages: [{ role: 'user', content: [{ type: 'input_audio', input_audio }] }], questions: { q } }));
    assert.equal(response.status, 422);
    assert.match((await response.json()).detail, /input_audio/);
  }
  assert.equal(calls, 0);
});

test('an audio answer without probabilities remains a 502', async () => {
  let calls = 0;
  const bridge = createBridge(config, { fetch: async () => { calls++; return Response.json({ choices: [{ message: { content: 'A' }, logprobs: null }] }); } });
  const response = await bridge(request({ messages: history, questions: { q } }));
  assert.equal(response.status, 502);
  const body = await response.json();
  assert.match(body.error.message, /no top_logprobs/);
  assert.equal(body.answers, undefined);
  assert.equal(calls, 2);
});

test('malformed audio_url fails before any upstream request', async () => {
  let calls = 0;
  const bridge = createBridge(config, { fetch: async () => { calls++; return upstream(); } });
  for (const audio_url of [null, [], 'https://example.com/audio.wav', {}, { url: 1 }, { url: ' ' }]) {
    const response = await bridge(request({ messages: [{ role: 'user', content: [{ type: 'audio_url', audio_url }] }], questions: { q } }));
    assert.equal(response.status, 422);
    assert.match((await response.json()).detail, /audio_url/);
  }
  assert.equal(calls, 0);
});

test('official passthrough preserves audio; capability remains upstream-specific', async () => {
  let sent;
  const bridge = createBridge(config, { fetch: async (_url, init) => { sent = JSON.parse(init.body); return Response.json({ answers: { q: { custom: 'kept' } } }); } });
  assert.equal((await bridge(request({ provider: 'official', messages: history, questions: { q } }))).status, 200);
  assert.deepEqual(sent, { model: 'jev', messages: history, questions: { q } });
});
