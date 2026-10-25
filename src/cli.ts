#!/usr/bin/env node
import { constants } from 'node:fs';
import { copyFile, lstat, mkdir, mkdtemp, readFile, realpath, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { composeImpactFrameImage, composeImpactFrameVideo } from './impact-frame-video.server.js';
import { type ImpactFrameVideoPoint, type ImpactFrameSpeed, type ImpactFrameTransition } from './impact-frame-video.js';

const help = `Usage: impact-frames compose <config.json> [--overwrite]

The JSON file contains videoPath OR sourceImagePath, outputPath and points.
Each point contains timestamp (seconds), imagePaths, speed and transition.
All paths are local and resolved relative to the JSON file.
Existing output files are refused unless --overwrite is supplied.
No image generation API is called. See examples/compose.json.`;

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function keys(value: Record<string, unknown>, allowed: string[], label: string) {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length) throw new Error(`Unknown ${label} fields: ${unknown.join(', ')}`);
}

function localPath(value: unknown, base: string, label: string): string {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0') || /^[a-z][a-z\d+.-]*:\/\//i.test(value)) {
    throw new Error(`${label} must be a local file path`);
  }
  return path.resolve(base, value);
}

async function main() {
  const args = process.argv.slice(2);
  if (!args.length || args[0] === '--help' || args[0] === '-h') { console.log(help); return; }
  if (args[0] !== 'compose' || !args[1] || args.length > 3 || (args[2] && args[2] !== '--overwrite')) throw new Error(help);
  const configPath = await realpath(path.resolve(args[1]));
  const base = path.dirname(configPath);
  const config = object(JSON.parse(await readFile(configPath, 'utf8')), 'config');
  keys(config, ['videoPath', 'sourceImagePath', 'outputPath', 'points'], 'config');
  if ((config.videoPath !== undefined) === (config.sourceImagePath !== undefined)) throw new Error('Specify exactly one of videoPath or sourceImagePath');
  const sourceIsImage = config.sourceImagePath !== undefined;
  const sourcePath = localPath(sourceIsImage ? config.sourceImagePath : config.videoPath, base, 'source');
  const outputPath = localPath(config.outputPath, base, 'outputPath');
  if (path.extname(outputPath).toLowerCase() !== '.mp4') throw new Error('outputPath must end in .mp4');
  if (!Array.isArray(config.points) || config.points.length < 1 || config.points.length > 50) throw new Error('points must contain 1–50 points');
  const points: ImpactFrameVideoPoint[] = config.points.map((raw, index) => {
    const point = object(raw, `points[${index}]`);
    keys(point, ['timestamp', 'imagePaths', 'speed', 'transition'], 'point');
    if (typeof point.timestamp !== 'number' || !Number.isFinite(point.timestamp) || point.timestamp < 0) throw new Error('timestamp must be a finite nonnegative number');
    if (!Array.isArray(point.imagePaths) || point.imagePaths.length < 1 || point.imagePaths.length > 50) throw new Error('imagePaths must contain 1–50 images');
    if (point.speed !== undefined && !['slow', 'medium', 'fast'].includes(String(point.speed))) throw new Error('Invalid speed');
    if (point.transition !== undefined && !['cut', 'dissolve', 'flash-black', 'flash-white'].includes(String(point.transition))) throw new Error('Invalid transition');
    return { timestamp: point.timestamp, imagePaths: point.imagePaths.map((file) => localPath(file, base, 'imagePaths')),
      speed: (point.speed as ImpactFrameSpeed | undefined) ?? 'fast',
      transition: (point.transition as ImpactFrameTransition | undefined) ?? 'cut' };
  });
  if (sourceIsImage && (points.length !== 1 || points[0].timestamp !== 0)) throw new Error('Image input requires one point at timestamp 0');
  const inputs = await Promise.all([configPath, sourcePath, ...points.flatMap((point) => point.imagePaths)].map(async (file) => {
    const resolved = await realpath(file);
    const info = await stat(resolved);
    if (!info.isFile()) throw new Error(`Not a file: ${file}`);
    return { path: resolved, info };
  }));
  await mkdir(path.dirname(outputPath), { recursive: true });
  const outputParent = await realpath(path.dirname(outputPath));
  const canonicalOutput = path.join(outputParent, path.basename(outputPath));
  const comparable = (file: string) => process.platform === 'win32' ? file.toLowerCase() : file;
  if (inputs.some((input) => comparable(input.path) === comparable(canonicalOutput))) throw new Error('Output must not overwrite an input file');
  const outputInfo = await lstat(outputPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error;
    return undefined;
  });
  if (outputInfo) {
    if (!outputInfo.isFile() || outputInfo.isSymbolicLink()) throw new Error('Output must be a regular file, not a directory or symbolic link');
    if (inputs.some(({ info }) => info.dev === outputInfo.dev && info.ino === outputInfo.ino)) throw new Error('Output must not overwrite an input file');
    if (args[2] !== '--overwrite') throw new Error('Output already exists; pass --overwrite to replace it');
  }
  // Render in a unique directory so concurrent jobs cannot share filter/source files.
  const workDir = await mkdtemp(path.join(outputParent, '.impact-frames-'));
  try {
    const renderedPath = path.join(workDir, 'output.mp4');
    const result = sourceIsImage
      ? await composeImpactFrameImage({ sourceImagePath: sourcePath, outputPath: renderedPath, points })
      : await composeImpactFrameVideo({ videoPath: sourcePath, outputPath: renderedPath, points });
    await copyFile(renderedPath, outputPath, args[2] === '--overwrite' ? 0 : constants.COPYFILE_EXCL);
    console.log(JSON.stringify({ outputPath, ...result }, null, 2));
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
