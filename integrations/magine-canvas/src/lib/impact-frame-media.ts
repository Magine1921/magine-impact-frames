import { getMaterialBlob, isMaterialIdbRef, materialRefToNodeId } from './canvas-material-idb';
import { isLocalFilesystemMediaPath, isProjectCacheMaterialUrl, materialDiskPlayableUrl, resolveMaterialPlayableUrl } from './material-disk-playable-url';
import { sniffBinaryMedia } from './maginecanvas-media-binary';
import { persistImageToMaterialCache, persistVideoToMaterialCache } from './persist-generated-media';

/** Use the full original, including IDB/blob inputs; never substitute a thumbnail. */
export async function prepareImpactFrameImage(url: string): Promise<{ url: string; width: number; height: number }> {
  let resolved = url;
  if (isMaterialIdbRef(resolved)) {
    resolved = (await getMaterialBlob(materialRefToNodeId(resolved), { requireOriginal: true }))?.fileUrl || '';
  }
  if (!resolved || isMaterialIdbRef(resolved)) throw new Error('原图片缺失，请重新导入图片');
  resolved = resolveMaterialPlayableUrl(resolved, 'image');
  if (!isProjectCacheMaterialUrl(resolved)) {
    const cacheId = `node_impact_source_${crypto.randomUUID()}`;
    if (/^https?:\/\//i.test(resolved) && await persistImageToMaterialCache(cacheId, resolved)) {
      resolved = materialDiskPlayableUrl(cacheId);
    } else {
      const response = await fetch(resolved);
      if (!response.ok) throw new Error(`原图片读取失败（HTTP ${response.status}），请重新导入图片`);
      const blob = await response.blob();
      const detected = sniffBinaryMedia(new Uint8Array(await blob.slice(0, 1024).arrayBuffer()));
      if (!blob.size || blob.size > 128 * 1024 * 1024 || detected.kind !== 'image') throw new Error('原图片为空、格式无效或超过 128MB');
      const form = new FormData();
      form.set('nodeId', cacheId);
      form.set('file', new Blob([blob], { type: detected.mime }), `impact-source${detected.ext}`);
      const uploaded = await fetch('/api/project-cache/material-upload', { method: 'POST', body: form });
      const result = await uploaded.json().catch(() => null);
      if (!uploaded.ok || result?.ok !== true) throw new Error(`图片保存失败：${result?.error || `HTTP ${uploaded.status}`}`);
      resolved = materialDiskPlayableUrl(cacheId);
    }
  }
  const dimensions = await new Promise<{ width: number; height: number }>((resolve, reject) => {
    const image = new Image();
    const fail = () => { clearTimeout(timer); reject(new Error('原图片无法解码，请重新导入图片')); };
    const timer = setTimeout(fail, 20_000);
    image.onload = () => {
      clearTimeout(timer);
      if (image.naturalWidth && image.naturalHeight) resolve({ width: image.naturalWidth, height: image.naturalHeight });
      else fail();
    };
    image.onerror = fail;
    image.src = resolved;
  });
  return { url: resolved, ...dimensions };
}

/** Resolve renderer-only media into a cache URL that preview, capture and FFmpeg can all read. */
export async function prepareImpactFrameVideoUrl(url: string): Promise<string> {
  let resolved = url;
  if (isMaterialIdbRef(resolved)) {
    const row = await getMaterialBlob(materialRefToNodeId(resolved), { requireOriginal: true });
    resolved = row?.fileUrl || '';
  }
  if (!resolved) throw new Error('视频素材缺失，请重新导入视频');
  resolved = resolveMaterialPlayableUrl(resolved, 'video');
  if (isProjectCacheMaterialUrl(resolved)) return resolved;

  const cacheId = `node_impact_source_${crypto.randomUUID()}`;
  const cachedUrl = materialDiskPlayableUrl(cacheId, 'video');
  // Remote URLs may require the server's download proxy; filesystem paths cannot be fetched by the renderer.
  const localPath = isLocalFilesystemMediaPath(resolved) && !resolved.startsWith('/');
  if (localPath || /^https?:\/\//i.test(resolved)) {
    if (await persistVideoToMaterialCache(cacheId, resolved)) return cachedUrl;
    if (localPath) throw new Error('本地视频读取失败，请确认原文件仍可访问后重试');
  }

  let blob: Blob;
  try {
    const response = await fetch(resolved);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    blob = await response.blob();
  } catch (cause) {
    throw new Error(`视频读取失败，请重新导入视频或重试：${cause instanceof Error ? cause.message : '无法访问视频'}`);
  }
  if (!blob.size) throw new Error('视频文件为空，请重新导入视频');
  if (blob.size > 128 * 1024 * 1024) throw new Error('视频超过 128MB，请截取需要的片段后重试');

  // Dragged/imported MP4s can have an empty or application/octet-stream MIME despite playing normally.
  const detected = sniffBinaryMedia(new Uint8Array(await blob.slice(0, 1024).arrayBuffer()));
  const mime = detected.kind === 'video' ? detected.mime : blob.type.startsWith('video/') ? blob.type : '';
  if (!mime) throw new Error('无法识别视频格式，请重新导入 MP4、MOV 或 WebM 视频');
  const form = new FormData();
  form.set('nodeId', cacheId);
  form.set('file', new Blob([blob], { type: mime }), `impact-source${detected.kind === 'video' ? detected.ext : '.mp4'}`);
  // Binary upload avoids the JSON endpoint's 32MB body limit and Base64 expansion.
  const response = await fetch('/api/project-cache/material-upload', { method: 'POST', body: form });
  const result = await response.json().catch(() => null);
  if (!response.ok || result?.ok !== true) {
    if (response.status === 413) throw new Error('视频超过缓存大小限制，请截取需要的片段后重试');
    throw new Error(`视频保存失败，请重试：${result?.error || `HTTP ${response.status}`}`);
  }
  return cachedUrl;
}
