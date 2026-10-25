export const IMPACT_FRAME_MAX_IMAGES = 50;
export const IMPACT_FRAME_DEFAULT_IMAGES = 6;
export const IMPACT_FRAME_IMAGE_FPS = 30;
export type ImpactFrameSpeed = 'slow' | 'medium' | 'fast';
export type ImpactFrameTransition = 'cut' | 'dissolve' | 'flash-black' | 'flash-white';

export class ImpactFrameInputError extends Error {}

export interface ImpactFrameVideoMetadata {
  duration: number;
  width: number;
  height: number;
  fps: number;
}

export interface ImpactFrameTiming {
  effectStart: number;
  effectEnd: number;
  secondsPerImage: number;
}

export interface ImpactFrameEffect extends ImpactFrameTiming {
  timestamp: number;
  imageCount: number;
}

export interface ImpactFrameVideoPoint {
  timestamp: number;
  imagePaths: string[];
  speed?: ImpactFrameSpeed;
  transition?: ImpactFrameTransition;
}

export type ImpactFrameVideoInput = {
  videoPath: string;
  outputPath: string;
} & ({ points: ImpactFrameVideoPoint[]; imagePaths?: never; timestamp?: never; speed?: never; transition?: never }
  | { imagePaths: string[]; timestamp: number; speed?: ImpactFrameSpeed; transition?: ImpactFrameTransition; points?: never });

function transitionFrameCount(speed: ImpactFrameSpeed, transition: ImpactFrameTransition): number {
  return transition === 'cut' ? 0 : speed === 'slow' ? 2 : 1;
}

export function planImpactFrameTiming(
  duration: number,
  fps: number,
  timestamp: number,
  imageCount: number,
  speed: ImpactFrameSpeed = 'medium',
  transition: ImpactFrameTransition = 'cut',
): ImpactFrameTiming {
  if (!Number.isInteger(imageCount) || imageCount < 1 || imageCount > IMPACT_FRAME_MAX_IMAGES) {
    throw new ImpactFrameInputError('每个截取点需要 1 至 50 张已生成的冲击图片');
  }
  if (speed !== 'slow' && speed !== 'medium' && speed !== 'fast') {
    throw new ImpactFrameInputError('冲击帧速度必须选择慢、中或快');
  }
  if (!['cut', 'dissolve', 'flash-black', 'flash-white'].includes(transition)) {
    throw new ImpactFrameInputError('冲击图转场方式无效');
  }
  if (!Number.isFinite(duration) || duration <= 0 || !Number.isFinite(fps) || fps <= 0) {
    throw new Error('无法读取视频时长或帧率');
  }
  if (!Number.isFinite(timestamp) || timestamp < 0 || timestamp > duration) {
    throw new ImpactFrameInputError('截取时间必须位于视频范围内，请重新截取');
  }
  const frameCount = Math.floor(duration * fps + 0.01);
  if (frameCount < imageCount) throw new ImpactFrameInputError('视频过短，无法展示全部冲击图片，请减少图片数量');
  const requestedFrames = speed === 'slow' ? 3 : speed === 'fast' ? 1 : 2;
  // Retain the legacy short-clip fallback for hard cuts. Transitions always leave
  // the selected number of full image frames visible on both sides of a boundary.
  const framesPerImage = transition === 'cut' ? Math.min(requestedFrames, Math.floor(frameCount / imageCount)) : requestedFrames;
  const effectFrames = imageCount * framesPerImage + (imageCount - 1) * transitionFrameCount(speed, transition);
  if (effectFrames > frameCount) throw new ImpactFrameInputError('视频过短，无法展示全部冲击图片及转场，请减少图片数量或加快速度');
  const startFrame = Math.min(Math.round(timestamp * fps), frameCount - effectFrames);
  return {
    effectStart: startFrame / fps,
    effectEnd: (startFrame + effectFrames) / fps,
    secondsPerImage: framesPerImage / fps,
  };
}

export function planImpactFrameEffects(
  duration: number,
  fps: number,
  points: { timestamp: number; imageCount: number; speed?: ImpactFrameSpeed; transition?: ImpactFrameTransition }[],
): ImpactFrameEffect[] {
  if (!points.length) throw new ImpactFrameInputError('请至少确认一个截取点');
  const effects = points.map(({ timestamp, imageCount, speed, transition }) => ({
    timestamp, imageCount, ...planImpactFrameTiming(duration, fps, timestamp, imageCount, speed, transition),
  })).sort((a, b) => a.effectStart - b.effectStart);
  for (let index = 1; index < effects.length; index += 1) {
    if (effects[index].effectStart < effects[index - 1].effectEnd - 1e-9) {
      throw new ImpactFrameInputError('截取点的冲击帧时间重叠，请拉开截取点间隔或减少图片数量');
    }
  }
  return effects;
}

export function planImpactFrameImageTiming(
  imageCount: number,
  speed: ImpactFrameSpeed = 'medium',
  transition: ImpactFrameTransition = 'cut',
): ImpactFrameTiming {
  const framesPerImage = speed === 'slow' ? 3 : speed === 'fast' ? 1 : 2;
  const duration = (imageCount * framesPerImage + (imageCount - 1) * transitionFrameCount(speed, transition)) / IMPACT_FRAME_IMAGE_FPS;
  return planImpactFrameTiming(duration, IMPACT_FRAME_IMAGE_FPS, 0, imageCount, speed, transition);
}

export function parseImpactFrameVideoMetadata(detail: string): ImpactFrameVideoMetadata {
  const durationMatch = detail.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/i);
  const videoLine = detail.split(/\r?\n/).find((line) => /Stream #.*Video:/.test(line)) || '';
  const size = videoLine.match(/\b(\d{2,5})x(\d{2,5})\b/);
  const frameRate = videoLine.match(/([\d.]+)\s+fps\b/);
  const duration = durationMatch
    ? Number(durationMatch[1]) * 3600 + Number(durationMatch[2]) * 60 + Number(durationMatch[3])
    : 0;
  let width = Number(size?.[1] || 0);
  let height = Number(size?.[2] || 0);
  const rotation = Number(detail.match(/rotation of (-?[\d.]+) degrees/)?.[1] || 0);
  if (Math.abs(rotation) % 180 === 90) [width, height] = [height, width];
  const fps = Number(frameRate?.[1] || 0);
  if (!duration || !width || !height || !fps) throw new Error('无法读取视频尺寸、时长或帧率，请更换有效的视频');
  return { duration, width: width - width % 2, height: height - height % 2, fps };
}

export function buildImpactFrameFfmpegArgs(params: ImpactFrameVideoInput & {
  metadata: ImpactFrameVideoMetadata;
  sourceIsImage?: boolean;
}): { args: string[]; timing: ImpactFrameTiming; effects: ImpactFrameEffect[] } {
  const { videoPath, outputPath, metadata } = params;
  const points = params.points ?? [{ timestamp: params.timestamp, imagePaths: params.imagePaths, speed: params.speed, transition: params.transition }];
  const effects = planImpactFrameEffects(metadata.duration, metadata.fps,
    points.map((point) => ({ timestamp: point.timestamp, imageCount: point.imagePaths.length, speed: point.speed, transition: point.transition })));
  const images = points.flatMap((point) => {
    const timing = effects.find((effect) => effect.timestamp === point.timestamp)!;
    const transition = point.transition ?? 'cut';
    const transitionFrames = transitionFrameCount(point.speed ?? 'medium', transition);
    return point.imagePaths.map((imagePath, index) => ({
      imagePath, transition, transitionFrames,
      previous: index > 0, next: index < point.imagePaths.length - 1,
      start: timing.effectStart + index * (timing.secondsPerImage + transitionFrames / metadata.fps),
      end: timing.effectStart + index * (timing.secondsPerImage + transitionFrames / metadata.fps) + timing.secondsPerImage,
    }));
  });
  const { width, height } = metadata;
  // Phone/screen recordings can have long gaps between source frames. Normalize before
  // the overlays so every flash is represented even in a sparse VFR section.
  const filters = [`[0:v:0]scale=${width}:${height},setsar=1,setpts=PTS-STARTPTS,tpad=stop_mode=clone:stop_duration=${metadata.duration},fps=${metadata.fps}:start_time=0[base]`];
  let output = 'base';
  let overlayIndex = 0;
  const enable = (start: number, end: number) => {
    // Place boundaries between frames so decimal rounding cannot duplicate or skip an image.
    const halfFrame = 0.5 / metadata.fps;
    return `gte(t,${(start - halfFrame).toFixed(9)})*lt(t,${(end - halfFrame).toFixed(9)})`;
  };
  const overlay = (label: string, start: number, end: number) => {
    const next = `flash${overlayIndex++}`;
    filters.push(`[${output}][${label}]overlay=eof_action=repeat:enable='${enable(start, end)}'[${next}]`);
    output = next;
  };
  // Dissolve frames reuse the adjacent stills; they do not consume any image's
  // full visibility time and need no additional input files or temporary images.
  images.forEach((image, index) => {
    const labels = [`image${index}`];
    if (image.transition === 'dissolve') {
      for (let frame = 0; frame < image.transitionFrames; frame += 1) {
        if (image.previous) labels.push(`image${index}in${frame}`);
        if (image.next) labels.push(`image${index}out${frame}`);
      }
    }
    filters.push(`[${index + 1}:v:0]scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},setsar=1,format=yuv420p${labels.length > 1 ? `,split=${labels.length}` : ''}${labels.map((label) => `[${label}]`).join('')}`);
  });
  images.forEach((image, index) => {
    overlay(`image${index}`, image.start, image.end);
    if (!image.next || !image.transitionFrames) return;
    if (image.transition === 'dissolve') {
      for (let frame = 0; frame < image.transitionFrames; frame += 1) {
        const weight = (frame + 1) / (image.transitionFrames + 1);
        const label = `dissolve${index}_${frame}`;
        filters.push(`[image${index}out${frame}][image${index + 1}in${frame}]blend=all_expr='A*${1 - weight}+B*${weight}'[${label}]`);
        overlay(label, image.end + frame / metadata.fps, image.end + (frame + 1) / metadata.fps);
      }
    } else {
      const next = `flash${overlayIndex++}`;
      const color = image.transition === 'flash-black' ? 'black' : 'white';
      filters.push(`[${output}]drawbox=x=0:y=0:w=iw:h=ih:color=${color}:t=fill:enable='${enable(image.end, image.end + image.transitionFrames / metadata.fps)}'[${next}]`);
      output = next;
    }
  });
  return {
    timing: effects[0],
    effects,
    args: [
      '-hide_banner', '-loglevel', 'error', '-y',
      ...(params.sourceIsImage ? ['-loop', '1', '-framerate', String(metadata.fps)] : []), '-i', videoPath,
      ...images.flatMap(({ imagePath }) => ['-i', imagePath]),
      '-filter_complex', filters.join(';'),
      '-map', `[${output}]`, ...(params.sourceIsImage ? ['-an'] : ['-map', '0:a?']),
      '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p',
      '-fps_mode', 'cfr', '-r', String(metadata.fps), '-c:a', 'aac', '-b:a', '192k',
      '-t', String(metadata.duration), '-movflags', '+faststart', outputPath,
    ],
  };
}
