import assert from 'node:assert/strict';
import test from 'node:test';
import {
  configureImpactFrameImageProvider, generateImpactFrameImage, getImpactFrameImageModels,
} from './src/lib/impact-frame-generation.ts';

const model = { value: 'host::image-edit', providerId: 'host', providerLabel: 'Host', model: 'image-edit', modelLabel: 'Image edit', label: 'Host · Image edit' };
const params = { prompt: 'retain the complete central subject', referenceImage: '/media/reference.png', width: 160, height: 90 };

test('unconfigured UI has no models and fails without submitting a request', async () => {
  assert.deepEqual(getImpactFrameImageModels(), []);
  await assert.rejects(generateImpactFrameImage(params), /请先接入/);
});

test('a reference rejection propagates after exactly one image request, without a text-only fallback', async () => {
  const calls = [];
  const dispose = configureImpactFrameImageProvider({ getModels: () => [model], generate: async (input) => {
    calls.push(input);
    throw new Error('reference rejected');
  } });
  try {
    await assert.rejects(generateImpactFrameImage(params), /reference rejected/);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].referenceImage, params.referenceImage);
    assert.equal(calls[0].prompt, params.prompt);
    assert.equal(calls[0].model, model.value);
  } finally { dispose(); }
});

test('disconnected media prevents submission and discards a result that becomes stale during generation', async () => {
  let current = false;
  let calls = 0;
  const dispose = configureImpactFrameImageProvider({ getModels: () => [model], generate: async () => {
    calls++;
    current = false;
    return '/media/result.png';
  } });
  try {
    const input = { ...params, isCurrent: () => current };
    await assert.rejects(generateImpactFrameImage(input), /已变更/);
    assert.equal(calls, 0);
    current = true;
    await assert.rejects(generateImpactFrameImage(input), /已变更/);
    assert.equal(calls, 1);
  } finally { dispose(); }
});

test('an explicitly unavailable model never falls back to a different enabled model', async () => {
  let calls = 0;
  const dispose = configureImpactFrameImageProvider({ getModels: () => [model], generate: async () => { calls++; return '/result.png'; } });
  try {
    await assert.rejects(generateImpactFrameImage({ ...params, model: 'host::missing' }), /不可用/);
    assert.equal(calls, 0);
  } finally { dispose(); }
});
