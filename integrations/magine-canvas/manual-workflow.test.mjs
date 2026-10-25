import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';
import * as core from '../../dist/index.js';

// Exercise the component's real click handlers with in-memory host services.
// Only the JSX return is replaced; the workflow under test is not reimplemented.
const source = readFileSync(new URL('./src/components/nodes/ImpactFrameNode.tsx', import.meta.url), 'utf8');
const marker = '  const atCursor =';
assert.equal(source.indexOf(marker), source.lastIndexOf(marker));
const workflow = source.slice(0, source.indexOf(marker))
  + '\n  return { compose, generate, capture, replaceSlotImage };\n}\nexport default ImpactFrameNode;\n';
const compiled = ts.transpileModule(workflow, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;

test('the complete extracted TSX component has valid syntax', () => {
  const parsed = ts.createSourceFile('ImpactFrameNode.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  assert.deepEqual(parsed.parseDiagnostics, []);
});

function harness({ mode = 'default', ready = false, count = 6, kind = 'image', cursor = 2, disconnectOnGenerate = false } = {}) {
  const input = { nodeId: 'source', fileUrl: `/cache/source.${kind === 'image' ? 'png' : 'mp4'}`, kind };
  let incoming = [input];
  const point = {
    id: 'point-1', sourceNodeId: input.nodeId, sourceVideoUrl: kind === 'video' ? input.fileUrl : '',
    ...(kind === 'image' ? { sourceImageUrl: input.fileUrl } : {}),
    frameUrl: '/cache/reference.png', time: kind === 'image' ? 0 : 1, width: 160, height: 90,
    speed: 'slow', transition: 'flash-white',
    slots: core.resizeImpactFrameSlots([], count).map((slot, i) => ({
      ...slot, ...(ready ? { imageUrl: `/cache/existing-${i}.png` } : {}),
    })),
  };
  point.slots[0].prompt = '用户自定义提示词';
  const node = { id: 'skill', position: { x: 0, y: 0 }, width: 440, data: { impactMode: mode, impactFrames: [point] } };
  const requests = [], notifications = [], generated = [], edges = [], captures = [];
  let running = 0, maxConcurrent = 0;
  const state = {
    nodes: [node],
    updateNodeData(id, patch) { Object.assign(state.nodes.find((item) => item.id === id).data, patch); },
    addNodeWithData(type, position, data) {
      const output = { id: `output-${state.nodes.length}`, type, position, data };
      state.nodes.push(output);
      return output.id;
    },
    onConnect(edge) { edges.push(edge); },
  };
  const store = (selector) => selector(state);
  store.getState = () => state;
  const sourceKey = `${kind}|${input.nodeId}|${input.fileUrl}`;
  let hookIndex = 0;
  const imports = {
    react: {
      memo: (component) => component,
      useEffect: () => {},
      useRef: (value) => ({ current: value }),
      useState: (initial) => {
        const index = hookIndex++;
        let value = typeof initial === 'function' ? initial() : initial;
        if (index === 1) value = { key: sourceKey, url: input.fileUrl, error: '' };
        if (index === 3) value = { key: sourceKey, url: input.fileUrl, duration: kind === 'video' ? 5 : 0 };
        if (index === 4) value = cursor;
        return [value, () => {}];
      },
    },
    reactflow: { useUpdateNodeInternals: () => () => {} },
    '../canvas/CanvasStore': { useCanvasStore: store },
    '../canvas/useCanvasDerivedData': { useIncomingMaterialRefs: () => incoming, getIncomingMaterialRefs: () => incoming },
    '../seedance/SeedanceStore': { useSeedanceStore: () => ({}) },
    '@/lib/material-mentions': { getMaterialReferenceKind: (item) => item.kind },
    '@/lib/material-import-from-file': { captureVideoFrameDataUrl: async (url, time) => {
      captures.push({ url, time });
      return { dataUrl: '/cache/captured.png', time, width: 160, height: 90 };
    } },
    '@/lib/material-disk-playable-url': {
      isProjectCacheMaterialUrl: (url) => url.startsWith('/cache/'),
      materialDiskPlayableUrl: (id) => `/cache/${id}`,
      resolveMaterialPlayableUrl: (url) => url,
    },
    '@/lib/persist-generated-media': { persistImageToMaterialCache: async () => true },
    '@/lib/impact-frame-media': {},
    '@/lib/generation-notification-store': { useGenerationNotificationStore: { getState: () => ({ notify: (event) => notifications.push(event) }) } },
    '@/lib/region-reparent': { getAbsoluteTopLeft: (item) => item.position },
    '@/lib/node-error-message': { unwrapNodeError: (error) => error },
    '@/lib/impact-frame': core,
    '@/lib/impact-frame-generation': {
      getImpactFrameImageModels: () => [{ value: 'host::image-edit', providerId: 'host', providerLabel: 'Host' }],
      generateImpactFrameImage: async (params) => {
        generated.push(params);
        running++;
        maxConcurrent = Math.max(maxConcurrent, running);
        if (disconnectOnGenerate) incoming = [];
        await new Promise((resolve) => setImmediate(resolve));
        running--;
        return `/cache/generated-${generated.length}.png`;
      },
    },
  };
  const module = { exports: {} };
  const fetch = async (url, options) => {
    const body = JSON.parse(options.body);
    requests.push({ url, body });
    return { ok: true, json: async () => body.validateOnly ? { ok: true } : { videoUrl: '/cache/result.mp4', width: 160, height: 90 } };
  };
  new Function('require', 'module', 'exports', 'fetch', compiled)((name) => {
    if (!(name in imports)) throw new Error(`Unexpected host dependency: ${name}`);
    return imports[name];
  }, module, module.exports, fetch);
  const handlers = module.exports.default({ id: node.id, data: node.data });
  return { handlers, node, state, point, requests, notifications, generated, edges, captures, maxConcurrent: () => maxConcurrent };
}

test('default image flow generates six images concurrently then saves output, link, history and one notice', async () => {
  const run = harness();
  await run.handlers.compose();
  assert.equal(run.generated.length, 6);
  assert.equal(run.maxConcurrent(), 6);
  assert.equal(run.requests.length, 2);
  assert.equal(run.requests[0].body.validateOnly, true);
  assert.equal(run.requests[1].body.points[0].speed, 'fast');
  assert.equal(run.requests[1].body.points[0].transition, 'cut');
  assert.equal(run.requests[1].body.points[0].imageUrls.length, 6);
  assert.equal(run.state.nodes.length, 2);
  assert.equal(run.edges.length, 1);
  assert.equal(run.node.data.generatedVideos.length, 1);
  assert.equal(run.notifications.length, 1);
  assert.equal(run.notifications[0].nodeId, run.node.data.generatedVideos[0].id);
  assert.equal(run.node.data.generationProgress.status, 'success');
  assert.equal(run.node.data.impactFrames[0].slots[0].prompt, '用户自定义提示词');
});

test('advanced composition uses existing images and per-point settings without submitting generation', async () => {
  const run = harness({ mode: 'advanced', ready: true, count: 8 });
  await run.handlers.compose();
  assert.equal(run.generated.length, 0);
  assert.equal(run.requests.length, 1);
  assert.equal(run.requests[0].body.points[0].speed, 'slow');
  assert.equal(run.requests[0].body.points[0].transition, 'flash-white');
  assert.equal(run.requests[0].body.points[0].imageUrls.length, 8);
  assert.equal(run.node.data.generationProgress.status, 'success');
});

test('advanced mode reports missing images without silently auto-generating or composing', async () => {
  const run = harness({ mode: 'advanced' });
  await run.handlers.compose();
  assert.equal(run.generated.length, 0);
  assert.equal(run.requests.length, 0);
  assert.equal(run.state.nodes.length, 1);
  assert.equal(run.node.data.generationProgress.status, 'error');
});

test('multiple individual image clicks join the manual queue', async () => {
  const run = harness({ mode: 'advanced', count: 2 });
  await Promise.all([
    run.handlers.generate(run.point.slots[0].id),
    run.handlers.generate(run.point.slots[1].id),
  ]);
  assert.equal(run.generated.length, 2);
  assert.equal(run.maxConcurrent(), 2);
  assert.ok(run.node.data.impactFrames[0].slots.every((slot) => slot.imageUrl));
  assert.equal(run.state.nodes.length, 1);
});

test('disconnecting input during generation prevents stale image writes, output, history and notices', async () => {
  const run = harness({ disconnectOnGenerate: true });
  await run.handlers.compose();
  assert.equal(run.state.nodes.length, 1);
  assert.equal(run.node.data.generatedVideos, undefined);
  assert.equal(run.notifications.length, 0);
  assert.ok(run.node.data.impactFrames[0].slots.every((slot) => !slot.imageUrl));
  assert.equal(run.requests.filter((request) => !request.body.validateOnly).length, 0);
});

test('default video flow captures the selected cursor and composes all retained points', async () => {
  const run = harness({ kind: 'video', ready: true, cursor: 2 });
  await run.handlers.compose();
  assert.deepEqual(run.captures, [{ url: '/cache/source.mp4', time: 2 }]);
  assert.equal(run.generated.length, 6);
  const request = run.requests.at(-1).body;
  assert.equal(request.videoUrl, '/cache/source.mp4');
  assert.deepEqual(request.points.map((point) => point.timestamp), [1, 2]);
  assert.equal(run.node.data.generationProgress.status, 'success');
});
