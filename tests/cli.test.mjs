import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile, link } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import sharp from 'sharp';
import { probeImpactFrameVideo } from '../dist/impact-frame-video.server.js';

const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const run = (config, ...args) => spawnSync(process.execPath, [cli, 'compose', config, ...args], {
  cwd: tmpdir(), encoding: 'utf8', windowsHide: true,
});

test('CLI resolves paths from the JSON file, renders real frames and protects existing output', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'impact-cli-'));
  try {
    await sharp({ create: { width: 64, height: 48, channels: 3, background: '#ff0000' } }).png().toFile(path.join(dir, 'source.png'));
    const configPath = path.join(dir, 'render.json');
    const config = { sourceImagePath: 'source.png', outputPath: 'output.mp4', points: [{ timestamp: 0, imagePaths: ['source.png'], speed: 'slow' }] };
    await writeFile(configPath, JSON.stringify(config));
    const rendered = run(configPath);
    assert.equal(rendered.status, 0, rendered.stderr);
    const metadata = JSON.parse(rendered.stdout);
    assert.equal(metadata.outputPath, path.join(dir, 'output.mp4'));
    assert.equal(metadata.imageCount, 1);
    assert.equal(metadata.duration, 0.1);
    assert.equal((await probeImpactFrameVideo(metadata.outputPath)).duration, 0.1);
    const original = await readFile(metadata.outputPath);
    const repeated = run(configPath);
    assert.equal(repeated.status, 1);
    assert.match(repeated.stderr, /already exists/);
    assert.deepEqual(await readFile(metadata.outputPath), original);
    assert.equal(run(configPath, '--overwrite').status, 0);
    assert.equal((await readdir(dir)).some((name) => name.startsWith('.impact-frames-')), false);
  } finally {
    assert.equal(path.dirname(dir), path.resolve(tmpdir()));
    await rm(dir, { recursive: true, force: true });
  }
});

test('CLI rejects invalid configurations, source overwrites and hard-link aliases before rendering', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'impact-cli-validate-'));
  try {
    const sourcePath = path.join(dir, 'source.mp4');
    await writeFile(sourcePath, 'keep input bytes');
    await link(sourcePath, path.join(dir, 'linked-output.mp4'));
    const configPath = path.join(dir, 'render.json');
    const base = { videoPath: 'source.mp4', outputPath: 'new-output.mp4', points: [{ timestamp: 0, imagePaths: ['source.mp4'] }] };
    const cases = [
      [{ ...base, outputPath: 'source.mp4' }, /must not overwrite an input/],
      [{ ...base, outputPath: 'linked-output.mp4' }, /must not overwrite an input/],
      [{ ...base, sourceImagePath: 'source.png' }, /exactly one/],
      [{ ...base, videoPath: 'https://example.com/source.mp4' }, /local file/],
      [{ ...base, points: [] }, /1–50 points/],
      [{ ...base, points: [{ timestamp: 0, imagePaths: Array(51).fill('source.mp4') }] }, /1–50 images/],
      [{ ...base, points: [{ timestamp: -1, imagePaths: ['source.mp4'] }] }, /nonnegative/],
      [{ ...base, points: [{ timestamp: 0, imagePaths: ['source.mp4'], speed: 'faster' }] }, /Invalid speed/],
      [{ ...base, unknownField: true }, /Unknown config/],
      [{ sourceImagePath: 'source.mp4', outputPath: 'new-output.mp4', points: [{ timestamp: 1, imagePaths: ['source.mp4'] }] }, /one point at timestamp 0/],
    ];
    for (const [config, error] of cases) {
      await writeFile(configPath, JSON.stringify(config));
      const result = run(configPath, '--overwrite');
      assert.equal(result.status, 1, result.stdout);
      assert.match(result.stderr, error);
    }
    assert.equal(await readFile(sourcePath, 'utf8'), 'keep input bytes');
    assert.equal((await readdir(dir)).includes('new-output.mp4'), false);
  } finally {
    assert.equal(path.dirname(dir), path.resolve(tmpdir()));
    await rm(dir, { recursive: true, force: true });
  }
});
