'use client';

/** Public host adapter. This file contains no MAGINE account or provider implementation. */
export interface ImpactFrameImageModel {
  value: string;
  label: string;
  providerId: string;
  providerLabel: string;
  model: string;
  modelLabel: string;
}

export interface ImpactFrameImageParams {
  prompt: string;
  referenceImage: string;
  width: number;
  height: number;
  model?: string;
  isCurrent?: () => boolean;
  onProgress?: (progress: number) => void;
}

export interface ImpactFrameImageProvider {
  /** Return only enabled models that accept a reference image. */
  getModels(): ImpactFrameImageModel[];
  /** Generate one image. Reference rejection must fail; never retry as text-only. */
  generate(params: ImpactFrameImageParams): Promise<string>;
}

let provider: ImpactFrameImageProvider | undefined;

/** Call once during host setup. Keep credentials on the host backend. */
export function configureImpactFrameImageProvider(next: ImpactFrameImageProvider): () => void {
  provider = next;
  return () => { if (provider === next) provider = undefined; };
}

export function getImpactFrameImageModels(): ImpactFrameImageModel[] {
  return provider?.getModels() ?? [];
}

export async function generateImpactFrameImage(params: ImpactFrameImageParams): Promise<string> {
  const current = provider;
  if (!current) throw new Error('请先接入支持参考图片的生图服务');
  if (!params.referenceImage.trim()) throw new Error('请先确认截取冲击帧参考图片');
  if (!params.prompt.trim()) throw new Error('请填写此图片的提示词');
  if (!(Number.isFinite(params.width) && params.width > 0 && Number.isFinite(params.height) && params.height > 0)) {
    throw new Error('参考帧尺寸无效，请重新截取');
  }
  const assertCurrent = () => {
    if (params.isCurrent?.() === false) throw new Error('参考素材或冲击帧节点已变更，已停止生成。');
  };
  assertCurrent();
  const models = current.getModels();
  const model = params.model ? models.find((item) => item.value === params.model) : models[0];
  if (!model) throw new Error('所选图像模型不可用或不支持参考图片；原素材和连线已保留');
  const url = await current.generate({ ...params, model: model.value });
  assertCurrent();
  if (typeof url !== 'string' || !url.trim()) throw new Error('生图服务未返回可读取的图片');
  return url;
}
