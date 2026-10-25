import { existsSync } from 'node:fs';
import { rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import sharp from 'sharp';
import { buildImpactFrameFfmpegArgs, IMPACT_FRAME_IMAGE_FPS, ImpactFrameInputError, parseImpactFrameVideoMetadata, planImpactFrameEffects, planImpactFrameImageTiming, type ImpactFrameSpeed, type ImpactFrameTransition, type ImpactFrameVideoInput, type ImpactFrameVideoMetadata, type ImpactFrameVideoPoint } from './impact-frame-video.js';

const execFileAsync = promisify(execFile);

export function resolveFfmpegPath(): string {
  if (process.env.FFMPEG_PATH) {
    if (!existsSync(process.env.FFMPEG_PATH)) throw new Error('FFMPEG_PATH does not point to an existing executable');
    return process.env.FFMPEG_PATH;
  }
  try {
    const bundled = createRequire(import.meta.url)('ffmpeg-static') as string | null;
    const executable = bundled?.replace('app.asar', 'app.asar.unpacked');
    if (executable && existsSync(executable)) return executable;
  } catch { /* Optional dependency: use the FFmpeg available on PATH. */ }
  return 'ffmpeg';
}

export async function probeImpactFrameVideo(videoPath: string) {
  const executable = resolveFfmpegPath();
  let detail = '';
  try {
    const result = await execFileAsync(executable, ['-hide_banner', '-i', videoPath], {
      timeout: 30_000, windowsHide: true, maxBuffer: 4 * 1024 * 1024,
    });
    detail = result.stderr;
  } catch (error) {
    // FFmpeg reports metadata on stderr and exits with 1 when no output is requested.
    detail = error && typeof error === 'object' && 'stderr' in error ? String(error.stderr || '') : '';
  }
  return parseImpactFrameVideoMetadata(detail);
}

export async function validateImpactFrameVideoPoints(params: {
  videoPath: string;
  points: { timestamp: number; imageCount: number; speed?: ImpactFrameSpeed; transition?: ImpactFrameTransition }[];
}) {
  const metadata = await probeImpactFrameVideo(params.videoPath);
  const effects = planImpactFrameEffects(metadata.duration, metadata.fps, params.points);
  return { pointCount: effects.length, effects };
}

export async function composeImpactFrameVideo(params: ImpactFrameVideoInput) {
  const metadata = await probeImpactFrameVideo(params.videoPath);
  return renderImpactFrames(params, metadata);
}

async function prepareImpactFrameImage(params: {
  sourceImagePath: string;
  points: { timestamp: number; imageCount: number; speed?: ImpactFrameSpeed; transition?: ImpactFrameTransition }[];
}) {
  if (params.points.length !== 1 || params.points[0].timestamp !== 0) {
    throw new ImpactFrameInputError('图片输入仅支持一个冲击图组，起始时间必须为 0');
  }
  const point = params.points[0];
  const timing = planImpactFrameImageTiming(point.imageCount, point.speed, point.transition);
  try {
    // Fully decode the original instead of trusting a filename, client dimensions,
    // or a valid-looking header. Normalization also honors camera orientation.
    const { data, info } = await sharp(params.sourceImagePath, { failOn: 'error' }).rotate().png().toBuffer({ resolveWithObject: true });
    if (info.width < 2 || info.height < 2) throw new Error('Image is too small');
    const metadata: ImpactFrameVideoMetadata = {
      width: info.width - info.width % 2, height: info.height - info.height % 2,
      duration: timing.effectEnd, fps: IMPACT_FRAME_IMAGE_FPS,
    };
    return { data, metadata, effects: [{ timestamp: 0, imageCount: point.imageCount, ...timing }] };
  } catch {
    throw new ImpactFrameInputError('无法读取有效的参考图片，请更换可正常打开且宽高至少为 2 像素的图片');
  }
}

export async function validateImpactFrameImagePoints(params: Parameters<typeof prepareImpactFrameImage>[0]) {
  const { metadata, effects } = await prepareImpactFrameImage(params);
  return { ...metadata, pointCount: 1, effects };
}

export async function composeImpactFrameImage(params: {
  sourceImagePath: string;
  outputPath: string;
  points: ImpactFrameVideoPoint[];
}) {
  const { data, metadata } = await prepareImpactFrameImage({ sourceImagePath: params.sourceImagePath,
    points: params.points.map((point) => ({ ...point, imageCount: point.imagePaths.length })),
  });
  const normalizedPath = `${params.outputPath}.source.png`;
  await writeFile(normalizedPath, data);
  try {
    return await renderImpactFrames({ videoPath: normalizedPath, outputPath: params.outputPath, points: params.points }, metadata, true);
  } finally {
    await rm(normalizedPath, { force: true }).catch(() => undefined);
  }
}

async function renderImpactFrames(params: ImpactFrameVideoInput, metadata: ImpactFrameVideoMetadata, sourceIsImage = false) {
  const executable = resolveFfmpegPath();
  const { args, timing, effects } = buildImpactFrameFfmpegArgs({ ...params, metadata, sourceIsImage });
  // Fifty slow dissolves exceed Windows' command-line size limit. Keep the
  // filter graph alongside this render's output and remove it after FFmpeg exits.
  const filterIndex = args.indexOf('-filter_complex');
  const filterPath = `${params.outputPath}.filters.txt`;
  await writeFile(filterPath, args[filterIndex + 1], 'utf8');
  args.splice(filterIndex, 2, '-filter_complex_script', filterPath);
  try {
    await execFileAsync(executable, args, {
      timeout: 15 * 60 * 1000, windowsHide: true, maxBuffer: 4 * 1024 * 1024,
    });
  } catch {
    throw new Error('冲击帧合成失败，请确认输入素材和全部冲击图片可以正常打开后重试');
  } finally {
    await rm(filterPath, { force: true }).catch(() => undefined);
  }
  return {
    ...metadata,
    ...(effects.length === 1 ? timing : {}),
    imageCount: effects.reduce((total, effect) => total + effect.imageCount, 0),
    pointCount: effects.length,
    effects,
  };
}
