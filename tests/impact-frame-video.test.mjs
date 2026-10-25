import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';
import * as helper from '../dist/impact-frame-video.js';
import * as server from '../dist/impact-frame-video.server.js';

const require = createRequire(import.meta.url);
const ffmpeg = server.resolveFfmpegPath();
const sharp = require('sharp');
const ff = (args) => execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', ...args], {
  windowsHide: true, maxBuffer: 10 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
});

test('impact timing uses two frames per image and shifts the full run inside the video at its end', () => {
  const timing = helper.planImpactFrameTiming(6, 30, 2, 5);
  assert.equal(timing.effectStart, 2);
  assert.equal(timing.effectEnd, 70 / 30);
  assert.equal(timing.secondsPerImage, 2 / 30);
  const atEnd = helper.planImpactFrameTiming(6, 30, 6, 10);
  assert.equal(atEnd.effectStart, 160 / 30);
  assert.equal(atEnd.effectEnd, 6);
  const short = helper.planImpactFrameTiming(0.2, 30, 0, 5);
  assert.equal(short.secondsPerImage, 1 / 30);
  assert.throws(() => helper.planImpactFrameTiming(0.1, 30, 0, 5), /视频过短/);
});

test('impact timing rejects missing images, excess images and invalid selection times', () => {
  for (const count of [0, 51, 2.5, NaN]) {
    assert.throws(() => helper.planImpactFrameTiming(6, 30, 2, count), /1 至 50/);
  }
  for (const timestamp of [-1, 6.1, Infinity, NaN]) {
    assert.throws(() => helper.planImpactFrameTiming(6, 30, timestamp, 5), /视频范围/);
  }
});

test('fast, medium and slow speeds use one, two and three frames per image and validate overlap at that speed', () => {
  assert.equal(helper.IMPACT_FRAME_MAX_IMAGES, 50);
  for (const [speed, frameCount] of [['fast', 1], ['medium', 2], ['slow', 3]]) {
    const timing = helper.planImpactFrameTiming(6, 30, 2, 30, speed);
    assert.equal(timing.secondsPerImage, frameCount / 30);
    assert.equal(timing.effectStart, 2);
    assert.equal(timing.effectEnd, 2 + frameCount);
  }
  assert.equal(helper.planImpactFrameTiming(0.2, 30, 0, 6, 'slow').secondsPerImage, 1 / 30,
    'a short clip can reduce the requested speed to one frame per image');
  for (const speed of ['', 'faster', null, 1]) {
    assert.throws(() => helper.planImpactFrameTiming(6, 30, 2, 6, speed), /速度/);
  }
  const points = [{ timestamp: 0.5, imageCount: 6, speed: 'fast' }, { timestamp: 0.7, imageCount: 6, speed: 'slow' }];
  const effects = helper.planImpactFrameEffects(3, 30, points);
  assert.equal(effects[0].effectEnd, effects[1].effectStart);
  assert.equal(effects[1].secondsPerImage, 3 / 30);
  assert.throws(() => helper.planImpactFrameEffects(3, 30, [{ ...points[0], speed: 'medium' }, points[1]]), /时间重叠/);
});

test('multiple points retain their own image counts and reject duplicate or overlapping flash intervals', () => {
  assert.equal(helper.IMPACT_FRAME_DEFAULT_IMAGES, 6);
  const effects = helper.planImpactFrameEffects(3, 30, [
    { timestamp: 2, imageCount: 10 }, { timestamp: 0.5, imageCount: 6 },
  ]);
  assert.deepEqual(effects.map(({ timestamp, imageCount }) => ({ timestamp, imageCount })), [
    { timestamp: 0.5, imageCount: 6 }, { timestamp: 2, imageCount: 10 },
  ]);
  assert.equal(helper.planImpactFrameEffects(3, 30, [
    { timestamp: 0.5, imageCount: 6 }, { timestamp: 0.9, imageCount: 6 },
  ]).length, 2, 'adjacent flash intervals can meet at the frame boundary');
  for (const points of [
    [{ timestamp: 1, imageCount: 6 }, { timestamp: 1, imageCount: 6 }],
    [{ timestamp: 1, imageCount: 6 }, { timestamp: 1.2, imageCount: 6 }],
    [{ timestamp: 2.7, imageCount: 6 }, { timestamp: 3, imageCount: 6 }],
  ]) assert.throws(() => helper.planImpactFrameEffects(3, 30, points), /时间重叠/);
  assert.throws(() => helper.planImpactFrameEffects(3, 30, []), /至少确认一个/);
  assert.throws(() => helper.planImpactFrameEffects(3, 30, [{ timestamp: NaN, imageCount: 6 }]), /视频范围/);
});

test('transition timing preserves each full image and counts boundary frames for short clips, end placement and overlaps', () => {
  for (const transition of ['dissolve', 'flash-black', 'flash-white']) {
    for (const [speed, imageFrames, boundaryFrames] of [['fast', 1, 1], ['medium', 2, 1], ['slow', 3, 2]]) {
      const timing = helper.planImpactFrameTiming(6, 30, 2, 6, speed, transition);
      const length = 6 * imageFrames + 5 * boundaryFrames;
      assert.equal(timing.secondsPerImage, imageFrames / 30);
      assert.equal(timing.effectEnd, (60 + length) / 30);
      const atEnd = helper.planImpactFrameTiming(6, 30, 6, 6, speed, transition);
      assert.equal(atEnd.effectStart, (180 - length) / 30);
      assert.equal(atEnd.effectEnd, 6);
      assert.throws(() => helper.planImpactFrameTiming((length - 1) / 30, 30, 0, 6, speed, transition), /视频过短/);
    }
    assert.equal(helper.planImpactFrameTiming(2, 30, 0, 1, 'fast', transition).effectEnd, 1 / 30,
      'one image has no internal boundary');
    assert.throws(() => helper.planImpactFrameEffects(3, 30, [
      { timestamp: 0.5, imageCount: 6, speed: 'fast', transition },
      { timestamp: 0.7, imageCount: 6, speed: 'fast', transition },
    ]), /时间重叠/);
  }
  for (const transition of ['', 'fade', null, 1]) {
    assert.throws(() => helper.planImpactFrameTiming(6, 30, 2, 6, 'fast', transition), /转场/);
  }
  assert.deepEqual(helper.planImpactFrameTiming(6, 30, 2, 6), helper.planImpactFrameTiming(6, 30, 2, 6, 'medium', 'cut'));
});

test('image timing produces exactly the required frames at 30 fps with no source duration cap', () => {
  for (const [speed, imageFrames, transitionFrames] of [['fast', 1, 1], ['medium', 2, 1], ['slow', 3, 2]]) {
    for (const transition of ['cut', 'dissolve', 'flash-black', 'flash-white']) {
      const timing = helper.planImpactFrameImageTiming(50, speed, transition);
      assert.equal(timing.effectStart, 0);
      assert.equal(timing.effectEnd, (50 * imageFrames + 49 * (transition === 'cut' ? 0 : transitionFrames)) / 30);
      assert.equal(timing.secondsPerImage, imageFrames / 30);
    }
  }
  for (const count of [0, 51, 1.5, NaN]) assert.throws(() => helper.planImpactFrameImageTiming(count), /1 至 50/);
  assert.throws(() => helper.planImpactFrameImageTiming(6, 'invalid'), /速度/);
  assert.throws(() => helper.planImpactFrameImageTiming(6, 'fast', 'invalid'), /转场/);
});

test('metadata respects rotated video dimensions and rejects non-video input', () => {
  const detail = 'Duration: 00:00:06.03, start: 0.000000\n Stream #0:0: Video: h264, yuv420p, 960x540, 30 fps\n displaymatrix: rotation of -90.00 degrees';
  assert.deepEqual(helper.parseImpactFrameVideoMetadata(detail), { duration: 6.03, width: 540, height: 960, fps: 30 });
  assert.throws(() => helper.parseImpactFrameVideoMetadata('Duration: 00:00:06.00\nStream #0:0 Audio: aac'), /有效的视频/);
});

test('FFmpeg output flashes every image in order, retains original motion length and audio, and handles silent video', async () => {
  const workDir = mkdtempSync(path.join(tmpdir(), 'magine-impact-test-'));
  const width = 64;
  const height = 48;
  const frameBytes = width * height * 3;
  const colors = [[0, 255, 0], [0, 0, 255], [255, 255, 255], [255, 255, 0], [0, 255, 255]];
  try {
    const imagePaths = colors.map((color, index) => {
      // PPM fixtures intentionally differ in aspect ratio from the video.
      const imagePath = path.join(workDir, `image-${index}.ppm`);
      const pixels = Buffer.alloc(16 * 16 * 3);
      for (let offset = 0; offset < pixels.length; offset += 3) pixels.set(color, offset);
      writeFileSync(imagePath, Buffer.concat([Buffer.from('P6\n16 16\n255\n'), pixels]));
      return imagePath;
    });
    const sourcePath = path.join(workDir, 'source.mp4');
    ff(['-f', 'lavfi', '-i', `color=red:size=${width}x${height}:rate=30:duration=1`,
      '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=1',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', sourcePath]);
    const outputPath = path.join(workDir, 'output.mp4');
    const result = await server.composeImpactFrameVideo({ videoPath: sourcePath, imagePaths, outputPath, timestamp: 0.2 });
    assert.equal(result.duration, 1);
    const frames = ff(['-i', outputPath, '-map', '0:v:0', '-pix_fmt', 'rgb24', '-f', 'rawvideo', 'pipe:1']);
    assert.equal(frames.length / frameBytes, 30, 'the effect must replace frames without appending time');
    const pixelAt = (frame) => [...frames.subarray(frame * frameBytes + (24 * width + 32) * 3, frame * frameBytes + (24 * width + 32) * 3 + 3)];
    function assertColor(frame, expected) {
      const actual = pixelAt(frame);
      actual.forEach((channel, index) => assert.ok(Math.abs(channel - expected[index]) <= 12,
        `frame ${frame}: expected ${expected}, got ${actual}`));
    }
    for (let frame = 0; frame < 30; frame += 1) {
      assertColor(frame, frame >= 6 && frame < 16 ? colors[Math.floor((frame - 6) / 2)] : [255, 0, 0]);
    }
    const audio = ff(['-i', outputPath, '-map', '0:a:0', '-f', 's16le', '-ac', '1', '-ar', '48000', 'pipe:1']);
    assert.ok(Math.abs(audio.length / 2 / 48000 - 1) < 0.04, 'source audio duration is retained');
    assert.ok(audio.some((value) => value !== 0), 'the source soundtrack must not become silence');

    const silentSource = path.join(workDir, 'silent.mp4');
    ff(['-i', sourcePath, '-map', '0:v:0', '-c', 'copy', silentSource]);
    const silentOutput = path.join(workDir, 'silent-output.mp4');
    const silentResult = await server.composeImpactFrameVideo({ videoPath: silentSource, imagePaths, outputPath: silentOutput, timestamp: 1 });
    assert.equal(silentResult.effectEnd, 1);
    const silentFrames = ff(['-i', silentOutput, '-map', '0:v:0', '-pix_fmt', 'rgb24', '-f', 'rawvideo', 'pipe:1']);
    assert.equal(silentFrames.length / frameBytes, 30);
    for (let frame = 20; frame < 30; frame += 1) {
      const offset = frame * frameBytes + (24 * width + 32) * 3;
      const actual = [...silentFrames.subarray(offset, offset + 3)];
      const expected = colors[Math.floor((frame - 20) / 2)];
      actual.forEach((channel, index) => assert.ok(Math.abs(channel - expected[index]) <= 12));
    }
    assert.throws(() => ff(['-i', silentOutput, '-map', '0:a:0', '-f', 'null', '-']), /matches no streams/);
  } finally {
    assert.equal(path.dirname(workDir), path.resolve(tmpdir()));
    rmSync(workDir, { recursive: true, force: true });
  }
});

test('variable-frame-rate footage displays every impact image without extending the video or shifting its audio', async (t) => {
  const workDir = mkdtempSync(path.join(tmpdir(), 'magine-impact-vfr-test-'));
  const width = 64, height = 48, frameBytes = width * height * 3;
  const colors = [[0, 255, 0], [0, 0, 255], [255, 255, 255], [255, 255, 0], [0, 255, 255]];
  try {
    const sourcePath = path.join(workDir, 'vfr-source.mp4');
    // 30 fps for the first second, then only five actual frames per second.
    ff(['-f', 'lavfi', '-i', `color=red:size=${width}x${height}:rate=30:duration=3`,
      '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=3',
      '-vf', "select='lt(t,1)+gte(t,1)*not(mod(n,6))'", '-fps_mode', 'vfr',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', sourcePath]);
    const sourceFrames = ff(['-i', sourcePath, '-map', '0:v:0', '-pix_fmt', 'rgb24', '-fps_mode', 'passthrough', '-f', 'rawvideo', 'pipe:1']);
    assert.equal(sourceFrames.length / frameBytes, 40, 'the fixture must retain its sparse frame timestamps');
    const images = colors.map((color, index) => {
      const imagePath = path.join(workDir, `image-${index}.ppm`);
      const pixels = Buffer.alloc(16 * 16 * 3);
      for (let offset = 0; offset < pixels.length; offset += 3) pixels.set(color, offset);
      writeFileSync(imagePath, Buffer.concat([Buffer.from('P6\n16 16\n255\n'), pixels]));
      return imagePath;
    });
    const outputPath = path.join(workDir, 'vfr-output.mp4');
    const result = await server.composeImpactFrameVideo({ videoPath: sourcePath, outputPath,
      points: [{ timestamp: 1.2, imagePaths: images }, { timestamp: 3, imagePaths: images }] });
    const frames = ff(['-i', outputPath, '-map', '0:v:0', '-pix_fmt', 'rgb24', '-fps_mode', 'passthrough', '-f', 'rawvideo', 'pipe:1']);
    const counts = colors.map(() => 0);
    const observedOrder = [];
    for (let frame = 0; frame < frames.length / frameBytes; frame += 1) {
      const offset = frame * frameBytes + (24 * width + 32) * 3;
      const pixel = [...frames.subarray(offset, offset + 3)];
      const index = colors.findIndex((color) => color.every((channel, i) => Math.abs(channel - pixel[i]) <= 12));
      if (index >= 0) {
        counts[index]++;
        if (observedOrder.at(-1) !== index) observedOrder.push(index);
      } else {
        [255, 0, 0].forEach((channel, i) => assert.ok(Math.abs(channel - pixel[i]) <= 12, 'frames outside the effect retain the source'));
      }
    }
    assert.deepEqual(counts, [4, 4, 4, 4, 4], 'every requested variant appears for exactly two frames at each point, including the video tail');
    assert.deepEqual(observedOrder, [0, 1, 2, 3, 4, 0, 1, 2, 3, 4]);
    const lastEffect = result.effects[1];
    assert.ok(Math.abs(lastEffect.effectEnd - 3) <= 1 / result.fps);
    for (let index = 0; index < 10; index++) {
      const frame = Math.round(lastEffect.effectStart * result.fps) + index;
      const offset = frame * frameBytes + (24 * width + 32) * 3;
      const actual = [...frames.subarray(offset, offset + 3)];
      const expected = colors[Math.floor(index / 2)];
      assert.equal(actual.length, 3, `tail frame ${frame} must exist`);
      actual.forEach((channel, component) => assert.ok(Math.abs(channel - expected[component]) <= 12,
        `tail frame ${frame}: expected ${expected}, got ${actual}`));
    }
    const outputFrameCount = frames.length / frameBytes;
    const durationError = Math.abs(outputFrameCount / result.fps - 3);
    if (durationError > 1 / result.fps) {
      t.diagnostic(JSON.stringify({ ffmpeg, version: ff(['-version']).toString().split('\n')[0],
        sourceMetadata: await server.probeImpactFrameVideo(sourcePath),
        outputMetadata: await server.probeImpactFrameVideo(outputPath),
        outputFrameCount, frameDuration: outputFrameCount / result.fps, durationError, tolerance: 1 / result.fps, result }));
      for (const [label, inputPath] of [['source', sourcePath], ['output', outputPath]]) {
        for (const codec of ['copy', 'rawvideo']) {
          const crc = ff(['-i', inputPath, '-map', '0:v:0', '-c:v', codec, '-fps_mode', 'passthrough', '-f', 'framecrc', 'pipe:1']).toString();
          const rows = crc.split('\n').filter((line) => line && !line.startsWith('#'));
          t.diagnostic(JSON.stringify({ label, codec, count: rows.length, header: crc.split('\n').filter((line) => line.startsWith('#')), first: rows.slice(0, 4), last: rows.slice(-6) }));
        }
      }
    }
    assert.ok(durationError <= 1 / result.fps, `duration stays within one output frame of the source (frames=${outputFrameCount}, fps=${result.fps}, duration=${result.duration}, error=${durationError})`);
    const audioArgs = ['-map', '0:a:0', '-f', 's16le', '-ac', '1', '-ar', '48000', 'pipe:1'];
    const sourceAudio = ff(['-i', sourcePath, ...audioArgs]);
    const outputAudio = ff(['-i', outputPath, ...audioArgs]);
    assert.ok(Math.abs(outputAudio.length - sourceAudio.length) / 2 / 48000 < 0.04, 'the original soundtrack duration is retained');
    assert.ok(outputAudio.subarray(0, 9600).some((value) => value !== 0), 'audio still begins at the start of the video');
  } finally {
    assert.equal(path.dirname(workDir), path.resolve(tmpdir()));
    rmSync(workDir, { recursive: true, force: true });
  }
});

test('two impact points appear in one output with all twelve images while intervening frames and audio retain their timing', async () => {
  const workDir = mkdtempSync(path.join(tmpdir(), 'magine-impact-multiple-test-'));
  const width = 64, height = 48, frameBytes = width * height * 3;
  const colors = [[0, 255, 0], [0, 0, 255], [255, 255, 255], [255, 255, 0], [0, 255, 255], [0, 0, 0]];
  try {
    const sourcePath = path.join(workDir, 'source.mp4');
    ff(['-f', 'lavfi', '-i', `color=red:size=${width}x${height}:rate=30:duration=2`,
      '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=2',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', sourcePath]);
    const images = colors.map((color, index) => {
      const imagePath = path.join(workDir, `image-${index}.ppm`);
      const pixels = Buffer.alloc(16 * 16 * 3);
      for (let offset = 0; offset < pixels.length; offset += 3) pixels.set(color, offset);
      writeFileSync(imagePath, Buffer.concat([Buffer.from('P6\n16 16\n255\n'), pixels]));
      return imagePath;
    });
    const outputPath = path.join(workDir, 'multiple.mp4');
    const result = await server.composeImpactFrameVideo({
      videoPath: sourcePath, outputPath,
      points: [{ timestamp: 1.4, imagePaths: [...images].reverse() }, { timestamp: 0.3, imagePaths: images }],
    });
    assert.equal(result.pointCount, 2);
    assert.equal(result.imageCount, 12, 'the limit applies to each point, not to the combined video');
    assert.deepEqual(result.effects.map((effect) => effect.timestamp), [0.3, 1.4]);
    assert.equal(result.duration, 2);
    const frames = ff(['-i', outputPath, '-map', '0:v:0', '-pix_fmt', 'rgb24', '-f', 'rawvideo', 'pipe:1']);
    assert.equal(frames.length / frameBytes, 60);
    for (let frame = 0; frame < 60; frame += 1) {
      const offset = frame * frameBytes + (24 * width + 32) * 3;
      const actual = [...frames.subarray(offset, offset + 3)];
      const expected = frame >= 9 && frame < 21 ? colors[Math.floor((frame - 9) / 2)]
        : frame >= 42 && frame < 54 ? colors[5 - Math.floor((frame - 42) / 2)] : [255, 0, 0];
      actual.forEach((channel, index) => assert.ok(Math.abs(channel - expected[index]) <= 12,
        `frame ${frame}: expected ${expected}, got ${actual}`));
    }
    const audio = ff(['-i', outputPath, '-map', '0:a:0', '-f', 's16le', '-ac', '1', '-ar', '48000', 'pipe:1']);
    assert.ok(Math.abs(audio.length / 2 / 48000 - 2) < 0.04);
    assert.ok(audio.subarray(0, 9600).some((value) => value !== 0));
    assert.ok(audio.subarray(48000 * 2, 48000 * 2 + 9600).some((value) => value !== 0));
    await assert.rejects(server.composeImpactFrameVideo({ videoPath: sourcePath, outputPath,
      points: [{ timestamp: 0.5, imagePaths: images }, { timestamp: 0.6, imagePaths: images }],
    }), /时间重叠/);
  } finally {
    assert.equal(path.dirname(workDir), path.resolve(tmpdir()));
    rmSync(workDir, { recursive: true, force: true });
  }
});

test('video-only preflight probes real frame timing and rejects overlaps and clips too short without rendering', async () => {
  const workDir = mkdtempSync(path.join(tmpdir(), 'magine-impact-preflight-test-'));
  try {
    const videoPath = path.join(workDir, 'source.mp4');
    ff(['-f', 'lavfi', '-i', 'color=red:size=64x48:rate=30:duration=2',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', videoPath]);
    const result = await server.validateImpactFrameVideoPoints({ videoPath,
      points: [{ timestamp: 0.5, imageCount: 6 }, { timestamp: 1.5, imageCount: 6 }],
    });
    assert.equal(result.pointCount, 2);
    assert.equal(result.effects[0].secondsPerImage, 2 / 30);
    await assert.rejects(server.validateImpactFrameVideoPoints({ videoPath,
      points: [{ timestamp: 0.5, imageCount: 6 }, { timestamp: 0.6, imageCount: 6 }],
    }), /时间重叠/);
    await assert.rejects(server.validateImpactFrameVideoPoints({ videoPath,
      points: [{ timestamp: 2.1, imageCount: 6 }],
    }), /视频范围/);
    const shortPath = path.join(workDir, 'short.mp4');
    ff(['-i', videoPath, '-t', '0.1', '-c:v', 'libx264', shortPath]);
    await assert.rejects(server.validateImpactFrameVideoPoints({ videoPath: shortPath,
      points: [{ timestamp: 0, imageCount: 6 }],
    }), /视频过短/);
    assert.deepEqual(readdirSync(workDir).sort(), ['short.mp4', 'source.mp4'], 'preflight creates no images or output video');
  } finally {
    assert.equal(path.dirname(workDir), path.resolve(tmpdir()));
    rmSync(workDir, { recursive: true, force: true });
  }
});

test('FFmpeg renders fifty fast images and a slow burst with exact per-image frame counts', async () => {
  const workDir = mkdtempSync(path.join(tmpdir(), 'magine-impact-speeds-test-'));
  const width = 64, height = 48, frameBytes = width * height * 3;
  const colors = [[0, 255, 0], [0, 0, 255], [255, 255, 255], [255, 255, 0], [0, 255, 255], [0, 0, 0]];
  try {
    const sourcePath = path.join(workDir, 'source.mp4');
    ff(['-f', 'lavfi', '-i', `color=red:size=${width}x${height}:rate=30:duration=3`,
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', sourcePath]);
    const images = colors.map((color, index) => {
      const imagePath = path.join(workDir, `image-${index}.ppm`);
      const pixels = Buffer.alloc(16 * 16 * 3);
      for (let offset = 0; offset < pixels.length; offset += 3) pixels.set(color, offset);
      writeFileSync(imagePath, Buffer.concat([Buffer.from('P6\n16 16\n255\n'), pixels]));
      return imagePath;
    });
    const outputPath = path.join(workDir, 'speeds.mp4');
    const result = await server.composeImpactFrameVideo({ videoPath: sourcePath, outputPath,
      points: [
        { timestamp: 0.2, imagePaths: Array.from({ length: 50 }, (_, index) => images[index % 6]), speed: 'fast' },
        { timestamp: 2, imagePaths: images, speed: 'slow' },
      ],
    });
    assert.equal(result.imageCount, 56);
    assert.equal(result.pointCount, 2);
    assert.equal(result.effects[0].secondsPerImage, 1 / 30);
    assert.equal(result.effects[1].secondsPerImage, 3 / 30);
    const frames = ff(['-i', outputPath, '-map', '0:v:0', '-pix_fmt', 'rgb24', '-f', 'rawvideo', 'pipe:1']);
    assert.equal(frames.length / frameBytes, 90, 'speed changes keep the source duration');
    for (let frame = 0; frame < 90; frame += 1) {
      const offset = frame * frameBytes + (24 * width + 32) * 3;
      const actual = [...frames.subarray(offset, offset + 3)];
      const expected = frame >= 6 && frame < 56 ? colors[(frame - 6) % 6]
        : frame >= 60 && frame < 78 ? colors[Math.floor((frame - 60) / 3)] : [255, 0, 0];
      actual.forEach((channel, index) => assert.ok(Math.abs(channel - expected[index]) <= 12,
        `frame ${frame}: expected ${expected}, got ${actual}`));
    }
    const preflight = await server.validateImpactFrameVideoPoints({ videoPath: sourcePath,
      points: [{ timestamp: 0.2, imageCount: 50, speed: 'fast' }, { timestamp: 2, imageCount: 6, speed: 'slow' }],
    });
    assert.deepEqual(preflight.effects, result.effects, 'preflight and rendering use the same speed-aware timing');
  } finally {
    assert.equal(path.dirname(workDir), path.resolve(tmpdir()));
    rmSync(workDir, { recursive: true, force: true });
  }
});

test('FFmpeg renders real dissolve, black and white boundary frames while retaining fifty full images, source timing and audio', async () => {
  const workDir = mkdtempSync(path.join(tmpdir(), 'magine-impact-transitions-test-'));
  const width = 64, height = 48, frameBytes = width * height * 3;
  const colors = [[0, 255, 0], [0, 0, 255]];
  try {
    const videoPath = path.join(workDir, 'source.mp4');
    ff(['-f', 'lavfi', '-i', `color=red:size=${width}x${height}:rate=30:duration=6`,
      '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=6',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', videoPath]);
    const images = colors.map((color, index) => {
      const imagePath = path.join(workDir, `image-${index}.ppm`);
      const pixels = Buffer.alloc(16 * 16 * 3);
      for (let offset = 0; offset < pixels.length; offset += 3) pixels.set(color, offset);
      writeFileSync(imagePath, Buffer.concat([Buffer.from('P6\n16 16\n255\n'), pixels]));
      return imagePath;
    });
    const points = [
      { timestamp: 0.2, imagePaths: Array.from({ length: 50 }, (_, index) => images[index % 2]), speed: 'fast', transition: 'dissolve' },
      { timestamp: 3.8, imagePaths: images, speed: 'slow', transition: 'dissolve' },
      { timestamp: 4.4, imagePaths: images, speed: 'medium', transition: 'flash-black' },
      { timestamp: 5, imagePaths: images, speed: 'slow', transition: 'flash-white' },
    ];
    const outputPath = path.join(workDir, 'transitions.mp4');
    const result = await server.composeImpactFrameVideo({ videoPath, outputPath, points });
    assert.equal(result.imageCount, 56);
    const preflight = await server.validateImpactFrameVideoPoints({ videoPath,
      points: points.map(({ timestamp, imagePaths, speed, transition }) => ({ timestamp, imageCount: imagePaths.length, speed, transition })),
    });
    assert.deepEqual(preflight.effects, result.effects, 'real preflight counts exactly the same transition frames as rendering');
    const frames = ff(['-i', outputPath, '-map', '0:v:0', '-pix_fmt', 'rgb24', '-f', 'rawvideo', 'pipe:1']);
    assert.equal(frames.length / frameBytes, 180);
    const expectedFrames = Array.from({ length: 180 }, () => [255, 0, 0]);
    for (const point of points) {
      let cursor = Math.round(point.timestamp * 30);
      const imageFrames = point.speed === 'slow' ? 3 : point.speed === 'medium' ? 2 : 1;
      const transitionFrames = point.speed === 'slow' ? 2 : 1;
      point.imagePaths.forEach((_, index) => {
        const color = colors[index % 2];
        for (let frame = 0; frame < imageFrames; frame++) expectedFrames[cursor++] = color;
        if (index === point.imagePaths.length - 1) return;
        for (let frame = 0; frame < transitionFrames; frame++) {
          const weight = (frame + 1) / (transitionFrames + 1);
          expectedFrames[cursor++] = point.transition === 'flash-black' ? [0, 0, 0]
            : point.transition === 'flash-white' ? [255, 255, 255]
            : color.map((channel, component) => channel * (1 - weight) + colors[(index + 1) % 2][component] * weight);
        }
      });
    }
    for (let frame = 0; frame < 180; frame++) {
      const offset = frame * frameBytes + (24 * width + 32) * 3;
      const actual = [...frames.subarray(offset, offset + 3)];
      const expected = expectedFrames[frame];
      actual.forEach((channel, index) => assert.ok(Math.abs(channel - expected[index]) <= 12,
        `frame ${frame}: expected ${expected}, got ${actual}`));
    }
    const audio = ff(['-i', outputPath, '-map', '0:a:0', '-f', 's16le', '-ac', '1', '-ar', '48000', 'pipe:1']);
    assert.ok(Math.abs(audio.length / 2 / 48000 - 6) < 0.04);
    for (const second of [0, 3, 5]) {
      assert.ok(audio.subarray(second * 96000, second * 96000 + 9600).some((value) => value !== 0));
    }
  } finally {
    assert.equal(path.dirname(workDir), path.resolve(tmpdir()));
    rmSync(workDir, { recursive: true, force: true });
  }
});

test('fifty slow dissolves render beyond the Windows command-line limit without losing images or leaving a filter script', async () => {
  const workDir = mkdtempSync(path.join(tmpdir(), 'magine-impact-fifty-slow-test-'));
  const width = 64, height = 48, frameBytes = width * height * 3;
  try {
    const videoPath = path.join(workDir, 'source.mp4');
    ff(['-f', 'lavfi', '-i', `color=red:size=${width}x${height}:rate=30:duration=9`,
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', videoPath]);
    const images = [[0, 255, 0], [0, 0, 255]].map((color, index) => {
      const imagePath = path.join(workDir, `image-${index}.ppm`);
      const pixels = Buffer.alloc(16 * 16 * 3);
      for (let offset = 0; offset < pixels.length; offset += 3) pixels.set(color, offset);
      writeFileSync(imagePath, Buffer.concat([Buffer.from('P6\n16 16\n255\n'), pixels]));
      return imagePath;
    });
    const input = { videoPath, outputPath: path.join(workDir, 'fifty-slow.mp4'), timestamp: 0.2,
      imagePaths: Array.from({ length: 50 }, (_, index) => images[index % 2]), speed: 'slow', transition: 'dissolve' };
    const { args } = helper.buildImpactFrameFfmpegArgs({ ...input, metadata: { duration: 9, fps: 30, width, height } });
    assert.ok(args.join(' ').length > 32767, 'the fixture exercises a filter graph too large for a Windows process argument');
    const result = await server.composeImpactFrameVideo(input);
    assert.equal(result.effectEnd, 254 / 30);
    const frames = ff(['-i', input.outputPath, '-map', '0:v:0', '-pix_fmt', 'rgb24', '-f', 'rawvideo', 'pipe:1']);
    assert.equal(frames.length / frameBytes, 270);
    for (let index = 0; index < 50; index++) {
      for (let frame = 0; frame < 3; frame++) {
        const position = 6 + index * 5 + frame;
        const offset = position * frameBytes + (24 * width + 32) * 3;
        const actual = [...frames.subarray(offset, offset + 3)];
        const expected = index % 2 ? [0, 0, 255] : [0, 255, 0];
        actual.forEach((channel, component) => assert.ok(Math.abs(channel - expected[component]) <= 12,
          `image ${index}, frame ${position}: expected ${expected}, got ${actual}`));
      }
    }
    assert.equal(readdirSync(workDir).some((name) => name.endsWith('.filters.txt')), false);
  } finally {
    assert.equal(path.dirname(workDir), path.resolve(tmpdir()));
    rmSync(workDir, { recursive: true, force: true });
  }
});

test('image-source composition contains only the requested images and four transition styles at every speed with no audio or padding', async () => {
  const workDir = mkdtempSync(path.join(tmpdir(), 'magine-impact-image-source-test-'));
  const width = 64, height = 48, frameBytes = width * height * 3;
  const colors = [[0, 255, 0], [0, 0, 255], [255, 255, 0]];
  try {
    const sourceImagePath = path.join(workDir, 'source-without-extension');
    await sharp({ create: { width, height, channels: 3, background: '#ff0000' } }).png().toFile(sourceImagePath);
    const imagePaths = await Promise.all(colors.map(async (color, index) => {
      const imagePath = path.join(workDir, `image-${index}.png`);
      await sharp({ create: { width: 16, height: 16, channels: 3,
        background: { r: color[0], g: color[1], b: color[2] } } }).png().toFile(imagePath);
      return imagePath;
    }));
    for (const [speed, imageFrames, boundaryFrames] of [['fast', 1, 1], ['medium', 2, 1], ['slow', 3, 2]]) {
      for (const transition of ['cut', 'dissolve', 'flash-black', 'flash-white']) {
        const outputPath = path.join(workDir, `${speed}-${transition}.mp4`);
        const points = [{ timestamp: 0, imagePaths, speed, transition }];
        const result = await server.composeImpactFrameImage({ sourceImagePath, outputPath, points });
        const expectedFrames = [];
        colors.forEach((color, index) => {
          for (let frame = 0; frame < imageFrames; frame++) expectedFrames.push(color);
          if (index === colors.length - 1 || transition === 'cut') return;
          for (let frame = 0; frame < boundaryFrames; frame++) {
            const weight = (frame + 1) / (boundaryFrames + 1);
            expectedFrames.push(transition === 'flash-black' ? [0, 0, 0] : transition === 'flash-white' ? [255, 255, 255]
              : color.map((channel, component) => channel * (1 - weight) + colors[index + 1][component] * weight));
          }
        });
        assert.equal(result.width, width);
        assert.equal(result.height, height);
        assert.equal(result.fps, 30);
        assert.equal(result.effectStart, 0);
        assert.equal(result.effectEnd, expectedFrames.length / 30);
        assert.equal(result.duration, expectedFrames.length / 30);
        const frames = ff(['-i', outputPath, '-map', '0:v:0', '-pix_fmt', 'rgb24', '-f', 'rawvideo', 'pipe:1']);
        assert.equal(frames.length / frameBytes, expectedFrames.length, `${speed} ${transition}: exact duration without source padding`);
        expectedFrames.forEach((expected, frame) => {
          const offset = frame * frameBytes + (24 * width + 32) * 3;
          const actual = [...frames.subarray(offset, offset + 3)];
          actual.forEach((channel, index) => assert.ok(Math.abs(channel - expected[index]) <= 12,
            `${speed} ${transition}, frame ${frame}: expected ${expected}, got ${actual}`));
        });
        assert.throws(() => ff(['-i', outputPath, '-map', '0:a:0', '-f', 'null', '-']), /matches no streams/);
        const preflight = await server.validateImpactFrameImagePoints({ sourceImagePath,
          points: [{ timestamp: 0, imageCount: 3, speed, transition }],
        });
        assert.deepEqual(preflight.effects, result.effects);
        assert.equal(preflight.duration, result.duration);
      }
    }
    const oneFramePath = path.join(workDir, 'one-frame.mp4');
    const oneFrame = await server.composeImpactFrameImage({ sourceImagePath, outputPath: oneFramePath,
      points: [{ timestamp: 0, imagePaths: imagePaths.slice(0, 1), speed: 'fast', transition: 'dissolve' }],
    });
    assert.equal(oneFrame.duration, 1 / 30);
    assert.equal(ff(['-i', oneFramePath, '-map', '0:v:0', '-pix_fmt', 'rgb24', '-f', 'rawvideo', 'pipe:1']).length, frameBytes);
    assert.equal(readdirSync(workDir).some((name) => /\.(source\.png|filters\.txt)$/.test(name)), false);
  } finally {
    assert.equal(path.dirname(workDir), path.resolve(tmpdir()));
    rmSync(workDir, { recursive: true, force: true });
  }
});

test('image-source preflight validates real image pixels, orientation, dimensions, count and single zero-time group', async () => {
  const workDir = mkdtempSync(path.join(tmpdir(), 'magine-impact-image-validate-test-'));
  try {
    const sourceImagePath = path.join(workDir, 'portrait.jpg');
    await sharp({ create: { width: 65, height: 49, channels: 3, background: 'red' } })
      .withMetadata({ orientation: 6 }).jpeg().toFile(sourceImagePath);
    const result = await server.validateImpactFrameImagePoints({ sourceImagePath,
      points: [{ timestamp: 0, imageCount: 50, speed: 'slow', transition: 'dissolve' }],
    });
    assert.equal(result.width, 48);
    assert.equal(result.height, 64);
    assert.equal(result.duration, 248 / 30);
    for (const points of [[], [{ timestamp: 1, imageCount: 3 }],
      [{ timestamp: 0, imageCount: 3 }, { timestamp: 1, imageCount: 3 }],
      [{ timestamp: 0, imageCount: 51 }],
    ]) await assert.rejects(server.validateImpactFrameImagePoints({ sourceImagePath, points }), helper.ImpactFrameInputError);
    const invalidImage = path.join(workDir, 'invalid.png');
    writeFileSync(invalidImage, 'not an image');
    const tinyImage = path.join(workDir, 'tiny.png');
    await sharp({ create: { width: 1, height: 20, channels: 3, background: 'red' } }).png().toFile(tinyImage);
    const corruptImage = path.join(workDir, 'corrupt.jpg');
    writeFileSync(corruptImage, readFileSync(sourceImagePath).subarray(0, 220));
    const videoPath = path.join(workDir, 'video.mp4');
    ff(['-f', 'lavfi', '-i', 'color=red:size=64x48:duration=0.1', '-c:v', 'libx264', videoPath]);
    for (const source of [invalidImage, tinyImage, corruptImage, videoPath]) {
      await assert.rejects(server.validateImpactFrameImagePoints({ sourceImagePath: source,
        points: [{ timestamp: 0, imageCount: 3 }],
      }), /有效的参考图片/);
    }
  } finally {
    assert.equal(path.dirname(workDir), path.resolve(tmpdir()));
    rmSync(workDir, { recursive: true, force: true });
  }
});
