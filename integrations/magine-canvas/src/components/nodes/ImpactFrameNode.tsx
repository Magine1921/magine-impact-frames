'use client';

import { memo, useEffect, useRef, useState } from 'react';
import { Handle, Position, useUpdateNodeInternals, type NodeProps } from 'reactflow';
import { ChevronDown, Film, Scissors, Sparkles, Trash2, Zap } from 'lucide-react';
import { useCanvasStore, type CanvasNodeData } from '../canvas/CanvasStore';
import { getIncomingMaterialRefs, useIncomingMaterialRefs } from '../canvas/useCanvasDerivedData';
import { useSeedanceStore } from '../seedance/SeedanceStore';
import { getMaterialReferenceKind } from '@/lib/material-mentions';
import { captureVideoFrameDataUrl } from '@/lib/material-import-from-file';
import { materialDiskPlayableUrl, resolveMaterialPlayableUrl, isProjectCacheMaterialUrl } from '@/lib/material-disk-playable-url';
import { persistImageToMaterialCache } from '@/lib/persist-generated-media';
import { prepareImpactFrameImage, prepareImpactFrameVideoUrl } from '@/lib/impact-frame-media';
import { useGenerationNotificationStore } from '@/lib/generation-notification-store';
import { getAbsoluteTopLeft } from '@/lib/region-reparent';
import { unwrapNodeError } from '@/lib/node-error-message';
import { generateImpactFrameImage, getImpactFrameImageModels } from '@/lib/impact-frame-generation';
import { applyImpactFrameGenerationMode, buildImpactFrameGenerationPrompt, canComposeImpactFrame, findImpactFramePointAtTime, getImpactFramePoints, isImpactFrameSourceCurrent, resizeImpactFrameSlots, IMPACT_FRAME_GENERATION_MODES, IMPACT_FRAME_MAX_IMAGES, type ImpactFrameBaseMode, type ImpactFrameGenerationMode, type ImpactFramePoint, type ImpactFrameSlot } from '@/lib/impact-frame';
import type { ImpactFrameTransition } from '@/lib/impact-frame-video';
import ImpactFrameTimeline from './ImpactFrameTimeline';
import { ImpactFrameReplaceButton, ImpactFrameZoomButton } from './ImpactFrameImageActions';
import { NodeGenerationOverlay } from '../canvas/NodeGenerationOverlay';
import { NodeProgressBorder } from '../canvas/NodeProgressBorder';

type SlotProgress = { progress: number; status: 'queued' | 'running' | 'success' | 'error' };
type GenerationQueue = {
  enqueue: (point: ImpactFramePoint, slotId: string) => void;
};

const controlClass = 'nodrag nopan rounded-lg border border-white/15 bg-black/25 px-2.5 py-2 text-xs outline-none focus:border-violet-300/60 disabled:opacity-40';
const actionClass = `${controlClass} inline-flex items-center justify-center gap-1.5 hover:bg-white/10 disabled:cursor-not-allowed`;
const speedOptions = [{ value: 'slow', label: '慢' }, { value: 'medium', label: '中' }, { value: 'fast', label: '快' }] as const;
const baseModeOptions = IMPACT_FRAME_GENERATION_MODES.filter((option): option is typeof option & { value: ImpactFrameBaseMode } => option.value !== 'mixed');
const modeDescriptions: Record<ImpactFrameGenerationMode, string> = {
  multicolor: '保留人物、动作和构图，变化颜色与明暗反差。',
  background: '保留画面中间主体的样貌、服装与动作，只更换背景；其他人物或物体不作为保留主体。',
  subject: '只变化画面中间主体的服装、材质与特效，保留其样貌；背景及其他人物或物体不变。',
  reconstruct: '保留人物样貌与构图关系，重新设计主体表现和背景。',
  mixed: '每张图随机使用一个已选模式，混合不同变化。',
};

async function saveImage(url: string): Promise<string> {
  if (isProjectCacheMaterialUrl(url)) return url;
  const cacheId = `node_impact_image_${crypto.randomUUID()}`;
  if (!await persistImageToMaterialCache(cacheId, url)) throw new Error('图片保存失败，请重试');
  return materialDiskPlayableUrl(cacheId);
}

function ImpactFrameNode({ id, data }: NodeProps<CanvasNodeData>) {
  const updateNodeData = useCanvasStore((state) => state.updateNodeData);
  const materials = useIncomingMaterialRefs(id);
  const sources = materials.filter((item) => ['video', 'image'].includes(getMaterialReferenceKind(item)));
  const source = sources.find((item) => item.nodeId === data.impactSourceNodeId) || sources[0];
  const sourceKind = source && getMaterialReferenceKind(source) === 'image' ? 'image' : 'video';
  const imageInput = sourceKind === 'image';
  const sourceKey = source ? `${sourceKind}|${source.nodeId}|${source.fileUrl}` : '';
  const points = getImpactFramePoints(data);
  const currentPoints = points.filter((point) => isImpactFrameSourceCurrent(point, source?.nodeId, source?.fileUrl, sourceKind)).sort((a, b) => a.time - b.time);
  const frame = currentPoints.find((point) => point.id === data.impactActivePointId) || currentPoints[0];
  const currentFrame = isImpactFrameSourceCurrent(frame, source?.nodeId, source?.fileUrl, sourceKind);
  const speedIndex = speedOptions.findIndex((option) => option.value === (frame?.speed || 'medium'));
  const mode = data.impactMode || 'default';
  const generationMode = frame?.generationMode || 'multicolor';
  const mixedModes = frame?.mixedModes?.length ? frame.mixedModes : baseModeOptions.map((option) => option.value);
  useSeedanceStore((state) => state.config);
  const models = getImpactFrameImageModels();
  const selectedModel = data.impactImageModel || models[0]?.value || '';
  const selectedModelOption = models.find((model) => model.value === selectedModel);
  const modelAvailable = !!selectedModelOption;
  const selectedProvider = selectedModelOption?.providerId || selectedModel.split('::')[0] || '';
  const providers = [...new Map(models.map((model) => [model.providerId, model.providerLabel])).entries()];
  const providerModels = models.filter((model) => model.providerId === selectedProvider);
  const [expanded, setExpanded] = useState(true);
  const [prepared, setPrepared] = useState({ key: '', url: '', error: '' });
  const sourceUrl = prepared.key === sourceKey ? prepared.url : '';
  const videoUrl = imageInput ? '' : sourceUrl;
  const [retry, setRetry] = useState(0);
  const [videoMetadata, setVideoMetadata] = useState({ key: '', url: '', duration: 0 });
  const duration = videoUrl && videoMetadata.key === sourceKey && videoMetadata.url === videoUrl ? videoMetadata.duration : 0;
  const [time, setTime] = useState(currentFrame ? frame!.time : 0);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [progress, setProgress] = useState('');
  const [overallProgress, setOverallProgress] = useState(0);
  const [slotProgress, setSlotProgress] = useState<Record<string, SlotProgress>>({});
  const [runId, setRunId] = useState(0);
  const [queueInput, setQueueInput] = useState<{ sourceKey: string; pointId: string } | null>(null);
  const [mixedPickerPointId, setMixedPickerPointId] = useState<string | null>(null);
  const modePickerRef = useRef<HTMLDivElement>(null);
  const mixedPickerOpen = !!frame && mixedPickerPointId === frame.id && mode === 'advanced';
  const runSerial = useRef(0);
  const videoRef = useRef<HTMLVideoElement>(null);
  const lock = useRef(false);
  const generationQueue = useRef<GenerationQueue | null>(null);
  const mounted = useRef(true);
  const composing = useRef(false);
  const updateInternals = useUpdateNodeInternals();

  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    if (composing.current) updateNodeData(id, {
      generationProgress: { status: 'processing', progress: overallProgress, message: progress || '正在制作冲击帧…' },
    }, { recordUndo: false });
  }, [id, overallProgress, progress, updateNodeData]);
  useEffect(() => {
    if (!mixedPickerOpen) return;
    const closeOutside = (event: PointerEvent) => {
      if (event.target instanceof Node && !modePickerRef.current?.contains(event.target)) setMixedPickerPointId(null);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.stopPropagation(); setMixedPickerPointId(null); }
    };
    document.addEventListener('pointerdown', closeOutside);
    document.addEventListener('keydown', closeOnEscape, true);
    return () => { document.removeEventListener('pointerdown', closeOutside); document.removeEventListener('keydown', closeOnEscape, true); };
  }, [mixedPickerOpen]);
  useEffect(() => { updateInternals(id); }, [expanded, mode, currentPoints.length, frame?.slots.length, id, updateInternals]);
  useEffect(() => {
    if (!sourceKey || !source) return;
    let cancelled = false;
    if (imageInput) {
      void prepareImpactFrameImage(source.fileUrl).then((image) => {
        if (cancelled) return;
        const node = useCanvasStore.getState().nodes.find((item) => item.id === id);
        if (!node) return;
        const incoming = getIncomingMaterialRefs(id).filter((item) => ['image', 'video'].includes(getMaterialReferenceKind(item)));
        const activeSource = incoming.find((item) => item.nodeId === node.data.impactSourceNodeId) || incoming[0];
        if (!activeSource || getMaterialReferenceKind(activeSource) !== 'image'
          || activeSource.nodeId !== source.nodeId || activeSource.fileUrl !== source.fileUrl) return;
        const stored = getImpactFramePoints(node.data);
        const existing = stored.find((point) => isImpactFrameSourceCurrent(point, source.nodeId, source.fileUrl, 'image'));
        const point: ImpactFramePoint = existing || {
          id: `impact-point-${crypto.randomUUID()}`, sourceNodeId: source.nodeId,
          sourceVideoUrl: '', sourceImageUrl: source.fileUrl, frameUrl: image.url,
          time: 0, width: image.width, height: image.height, slots: resizeImpactFrameSlots([]),
        };
        updateNodeData(id, { impactFrame: undefined, impactFrames: existing ? stored : [...stored, point], impactActivePointId: point.id });
        setPrepared({ key: sourceKey, url: image.url, error: '' });
      }).catch((cause) => {
        if (!cancelled) setPrepared({ key: sourceKey, url: '', error: cause instanceof Error ? cause.message : '图片读取失败' });
      });
    } else {
      void prepareImpactFrameVideoUrl(source.fileUrl).then((url) => {
        if (!cancelled) setPrepared({ key: sourceKey, url, error: '' });
      }).catch((cause) => {
        if (!cancelled) setPrepared({ key: sourceKey, url: '', error: cause instanceof Error ? cause.message : '视频读取失败' });
      });
    }
    return () => { cancelled = true; };
  }, [sourceKey, source, imageInput, retry, id, updateNodeData]);

  const sourceError = prepared.key === sourceKey ? prepared.error : '';
  const stillCurrent = (capturedPoints: ImpactFramePoint[] = []) => {
    if (!mounted.current) return false;
    const node = useCanvasStore.getState().nodes.find((item) => item.id === id);
    if (!node) return false;
    const currentSources = getIncomingMaterialRefs(id).filter((item) => ['video', 'image'].includes(getMaterialReferenceKind(item)));
    const currentSource = currentSources.find((item) => item.nodeId === node.data.impactSourceNodeId) || currentSources[0];
    const storedPoints = getImpactFramePoints(node.data);
    return !!currentSource && `${getMaterialReferenceKind(currentSource)}|${currentSource.nodeId}|${currentSource.fileUrl}` === sourceKey
      && capturedPoints.every((captured) => storedPoints.some((point) => point.id === captured.id && point.frameUrl === captured.frameUrl));
  };
  const latestPoints = () => getImpactFramePoints(useCanvasStore.getState().nodes.find((node) => node.id === id)?.data || {});
  const latestCurrentPoints = () => latestPoints().filter((point) => isImpactFrameSourceCurrent(point, source?.nodeId, source?.fileUrl, sourceKind)).sort((a, b) => a.time - b.time);
  const patchPoint = (pointId: string, patch: Partial<ImpactFramePoint>) => {
    updateNodeData(id, { impactFrame: undefined, impactFrames: latestPoints().map((point) => point.id === pointId ? { ...point, ...patch } : point) });
  };
  const patchSlot = (pointId: string, slotId: string, patch: Partial<ImpactFrameSlot>) => {
    const point = latestPoints().find((item) => item.id === pointId);
    if (point) patchPoint(pointId, { slots: point.slots.map((slot) => slot.id === slotId ? { ...slot, ...patch } : slot) });
  };
  const changeGenerationMode = (nextMode: ImpactFrameGenerationMode, selectedModes = mixedModes) => {
    if (!frame || !currentFrame || lock.current) return;
    patchPoint(frame.id, { generationMode: nextMode, mixedModes: selectedModes,
      slots: applyImpactFrameGenerationMode(frame.slots, nextMode, selectedModes) });
    setError('');
    setNotice(frame.slots.some((slot) => slot.imageUrl) ? '已更新生成模式；已有图片保留，可逐张重新生成。' : '');
  };
  const start = (phase: string) => {
    lock.current = true; setRunId(++runSerial.current);
    setBusy(phase); setError(''); setNotice(''); setProgress(''); setOverallProgress(0); setSlotProgress({});
  };
  const reportOverall = (value: number) => setOverallProgress((previous) => Math.max(previous, Math.min(100, Math.round(value))));
  const finish = () => { generationQueue.current = null; lock.current = false; if (mounted.current) { setBusy(''); setProgress(''); setSlotProgress({}); setQueueInput(null); } };
  const seek = (next: number) => {
    setTime(next);
    if (videoRef.current) { videoRef.current.pause(); videoRef.current.currentTime = next; }
  };
  const selectPoint = (point: ImpactFramePoint, openEditor = false) => {
    updateNodeData(id, { impactActivePointId: point.id, ...(openEditor ? { impactMode: 'advanced' as const } : {}) });
    seek(point.time); setError(''); setNotice('');
  };
  const removePoint = () => {
    if (!frame || lock.current) return;
    const remaining = latestPoints().filter((point) => point.id !== frame.id);
    const next = remaining.find((point) => isImpactFrameSourceCurrent(point, source?.nodeId, source?.fileUrl, sourceKind));
    updateNodeData(id, { impactFrame: undefined, impactFrames: remaining, impactActivePointId: next?.id });
    if (next) seek(next.time);
    setError(''); setNotice('');
  };

  const capturePoint = async (): Promise<ImpactFramePoint | undefined> => {
    if (!source || !videoUrl || !duration) return;
    const targetTime = Math.max(0, Math.min(time, duration - 0.08));
    const existing = findImpactFramePointAtTime(latestCurrentPoints(), targetTime);
    if (existing) { selectPoint(existing); return existing; }
    setBusy('capture'); setProgress('正在截取画面…');
    const captured = await captureVideoFrameDataUrl(videoUrl, targetTime);
    const frameUrl = await saveImage(captured.dataUrl);
    if (!stillCurrent()) return;
    const point: ImpactFramePoint = {
      id: `impact-point-${crypto.randomUUID()}`,
      sourceNodeId: source.nodeId, sourceVideoUrl: source.fileUrl,
      frameUrl, time: captured.time, width: captured.width, height: captured.height,
      slots: resizeImpactFrameSlots([]),
    };
    updateNodeData(id, { impactFrame: undefined, impactFrames: [...latestPoints(), point], impactActivePointId: point.id });
    seek(point.time);
    return point;
  };

  const capture = async () => {
    if (!source || !videoUrl || lock.current) return;
    start('capture');
    videoRef.current?.pause();
    try { if (await capturePoint()) reportOverall(100); }
    catch (cause) { if (stillCurrent()) setError(cause instanceof Error ? cause.message : '截帧失败'); }
    finally { finish(); }
  };

  const generatePoints = async (targets: ImpactFramePoint[], slotId?: string, composing = false): Promise<boolean> => {
    const pending = targets.flatMap((point) => point.slots.filter((slot) => slotId ? slot.id === slotId : !slot.imageUrl || slot.error).map((slot) => ({ point, slot })));
    if (pending.length && !getImpactFrameImageModels().some((model) => model.value === selectedModel)) throw new Error('请先配置或选择可用的图生图模型');
    if (!pending.length) return true;
    const serial = runSerial.current;
    const jobs: Record<string, SlotProgress> = Object.fromEntries(pending.map(({ point, slot }) => [`${point.id}:${slot.id}`, { progress: 0, status: 'queued' }]));
    const active = () => runSerial.current === serial && stillCurrent(targets);
    const updateJob = (key: string, value: number, status: SlotProgress['status']) => {
      if (!active()) return;
      const previous = jobs[key];
      const next = Number.isFinite(value) ? Math.max(previous.progress, Math.min(100, Math.round(value))) : previous.progress;
      jobs[key] = { progress: next, status };
      setSlotProgress({ ...jobs });
      const values = Object.values(jobs);
      const percent = 5 + values.reduce((sum, job) => sum + job.progress, 0) / values.length * (composing ? 0.85 : 0.95);
      setOverallProgress(Math.round(Math.min(composing ? 90 : values.every((job) => job.status === 'success') ? 100 : 99, percent)));
      setProgress(`冲击图片 ${values.filter((job) => job.status === 'success').length} / ${values.length} 张已完成 · ${values.filter((job) => job.status === 'running').length} 张同时生成`);
    };
    let pump = () => {};
    if (!composing) {
      const canAppend = (point: ImpactFramePoint) => active() && targets.some((target) => target.id === point.id && target.frameUrl === point.frameUrl);
      setQueueInput({ sourceKey, pointId: targets[0].id });
      generationQueue.current = {
        enqueue(point, selectedSlotId) {
          if (!canAppend(point)) return;
          const slot = point.slots.find((item) => item.id === selectedSlotId);
          if (!slot || !slot.prompt.trim()) return;
          const key = `${point.id}:${slot.id}`;
          if (jobs[key]) return;
          jobs[key] = { progress: 0, status: 'queued' };
          pending.push({ point, slot });
          updateJob(key, 0, 'queued');
          pump();
        },
      };
    }
    setSlotProgress({ ...jobs });
    try {
      const validationPoints = latestCurrentPoints();
      const snapshot = JSON.stringify(validationPoints);
      setBusy('validate'); setProgress(imageInput ? '正在检查图片和闪播时长…' : '正在检查截取点的闪播时间…');
      reportOverall(3);
      const response = await fetch('/api/impact-frame/compose', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nodeId: id, ...(imageInput ? { sourceImageUrl: sourceUrl } : { videoUrl }), validateOnly: true,
          points: validationPoints.map((point) => ({ timestamp: point.time, imageCount: point.slots.length, speed: mode === 'default' ? 'fast' : point.speed || 'medium', transition: mode === 'default' ? 'cut' : point.transition || 'dissolve' })) }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || '截取点检查失败，请重试');
      if (!active() || JSON.stringify(latestCurrentPoints()) !== snapshot) return false;
      setBusy('generate'); reportOverall(5);
      const runJob = async ({ point, slot }: typeof pending[number]) => {
        const key = `${point.id}:${slot.id}`;
        updateJob(key, 1, 'running');
        try {
          const imageUrl = await generateImpactFrameImage({ prompt: buildImpactFrameGenerationPrompt(slot), referenceImage: point.frameUrl, width: point.width, height: point.height, model: selectedModel, isCurrent: active,
            onProgress: (value) => { if (jobs[key].status === 'running') updateJob(key, Math.min(95, value), 'running'); },
          });
          if (!active()) return;
          updateJob(key, 95, 'running');
          const savedUrl = await saveImage(imageUrl);
          if (!active()) return;
          patchSlot(point.id, slot.id, { imageUrl: savedUrl, error: undefined });
          updateJob(key, 100, 'success');
        } catch (cause) {
          if (!active()) return;
          patchSlot(point.id, slot.id, { error: cause instanceof Error ? cause.message : '图片生成失败，请重试' });
          updateJob(key, jobs[key].progress, 'error');
        }
      };
      await new Promise<void>((resolve) => {
        let running = 0;
        let nextIndex = 0;
        pump = () => {
          while (running < 6 && nextIndex < pending.length && active()) {
            running++;
            void runJob(pending[nextIndex++]).finally(() => { running--; pump(); });
          }
          if (!running) resolve();
        };
        pump();
      });
      if (!active()) return false;
      const failed = Object.values(jobs).filter((job) => job.status === 'error').length;
      if (failed) setError(`${failed} 张图片生成失败。已保留成功图片，可再次点击合成重试，或在高级模式中编辑。`);
      return failed === 0;
    } finally {
      generationQueue.current = null;
    }
  };

  const generate = async (slotId?: string) => {
    if (!frame || !currentFrame || !sourceUrl || !modelAvailable) return;
    if (lock.current) {
      try { if (slotId) generationQueue.current?.enqueue(frame, slotId); }
      catch (cause) { setError(cause instanceof Error ? cause.message : '图片生成失败'); }
      return;
    }
    start('validate');
    try {
      if (await generatePoints([frame], slotId) && stillCurrent([frame])) setNotice('所选冲击图片已生成。');
    } catch (cause) {
      if (stillCurrent([frame])) setError(cause instanceof Error ? cause.message : '图片生成失败');
    } finally { finish(); }
  };

  const replaceSlotImage = async (point: ImpactFramePoint, slotId: string, url: string) => {
    if (lock.current) throw new Error('请等待当前操作完成后再替换');
    start('replace');
    try {
      const savedUrl = await saveImage(url);
      if (!stillCurrent([point]) || !latestPoints().find((item) => item.id === point.id)?.slots.some((slot) => slot.id === slotId)) {
        throw new Error('截取点已变化，请重新选择要替换的图片');
      }
      patchSlot(point.id, slotId, { imageUrl: savedUrl, error: undefined });
      reportOverall(100);
      setNotice('冲击图已替换，合成时将使用新图片。');
    } finally { finish(); }
  };

  const completeComposition = (success: boolean, message: string) => {
    composing.current = false;
    if (mounted.current) updateNodeData(id, {
      generationProgress: { status: success ? 'success' : 'error', progress: success ? 100 : 0, message },
    }, { recordUndo: false });
  };

  const compose = async (): Promise<void> => {
    if (lock.current) return;
    start('compose');
    composing.current = true;
    updateNodeData(id, { generationProgress: { status: 'processing', progress: 0, message: '正在制作冲击帧…' } }, { recordUndo: false });
    videoRef.current?.pause();
    try {
      if (!source || !sourceUrl || (!imageInput && !duration)) throw new Error('请先连接可读取的图片或视频素材');
      if (!imageInput && mode === 'default' && !await capturePoint()) {
        throw new Error('输入素材已变化，已停止截帧');
      }
      let targets = latestCurrentPoints();
      if (!targets.length || !stillCurrent(targets)) throw new Error('输入素材或截取点已变化，请重新选择后生成');
      if (mode === 'default' && !await generatePoints(targets, undefined, true)) {
        throw new Error(stillCurrent(targets) ? '部分冲击图片生成失败，已保留成功图片和提示词，请检查后重试' : '输入素材或截取点已变化，已停止生成');
      }
      targets = latestCurrentPoints();
      if (!targets.every(canComposeImpactFrame) || !stillCurrent(targets)) throw new Error('冲击图片尚未全部生成，或输入素材已变化');
      const snapshot = JSON.stringify(targets);
      setBusy('compose'); setProgress(imageInput ? '正在合成图片冲击帧视频…' : `正在合成 ${targets.length} 个冲击点…`);
      reportOverall(95);
      const response = await fetch('/api/impact-frame/compose', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nodeId: id, ...(imageInput ? { sourceImageUrl: sourceUrl } : { videoUrl }), points: targets.map((point) => ({ timestamp: point.time, imageUrls: point.slots.map((slot) => slot.imageUrl), speed: mode === 'default' ? 'fast' : point.speed || 'medium', transition: mode === 'default' ? 'cut' : point.transition || 'dissolve' })) }),
      });
      const result = await response.json();
      if (!response.ok || !result.videoUrl) throw new Error(result.error || '视频合成失败');
      if (!stillCurrent(targets) || JSON.stringify(latestCurrentPoints()) !== snapshot) throw new Error('输入素材或截取点已变化，未写入过期成品');
      const state = useCanvasStore.getState();
      const self = state.nodes.find((node) => node.id === id)!;
      const origin = getAbsoluteTopLeft(self, new Map(state.nodes.map((node) => [node.id, node])));
      const outputId = state.addNodeWithData('material', { x: origin.x + (self.width || 440) + 80, y: origin.y }, {
        label: '冲击帧成品', fileName: '冲击帧成品.mp4', fileType: 'video',
        fileUrl: result.videoUrl, thumbnailUrl: targets[0].frameUrl,
        materialAspectW: result.width || targets[0].width, materialAspectH: result.height || targets[0].height,
      }, { captureEntrance: true, syncCommit: true });
      useCanvasStore.getState().onConnect({ source: id, sourceHandle: null, target: outputId, targetHandle: null });
      updateNodeData(id, {
        generatedVideos: [{
          id: outputId, videoUrl: result.videoUrl, posterUrl: targets[0].frameUrl,
          // eslint-disable-next-line react-hooks/purity -- Completion time is recorded only by this async click handler.
          fileName: '冲击帧成品.mp4', createdAt: Date.now(),
        }, ...(Array.isArray(self.data.generatedVideos) ? self.data.generatedVideos : [])],
      }, { recordUndo: false });
      useGenerationNotificationStore.getState().notify({ nodeId: outputId, outcome: 'success', summary: '冲击帧成品' });
      reportOverall(100);
      const message = `已输出成品视频 · ${imageInput ? '图片冲击帧' : `${targets.length} 个冲击点`} · ${targets.reduce((sum, point) => sum + point.slots.length, 0)} 张图片`;
      setNotice(message);
      completeComposition(true, message);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : '视频合成失败';
      if (stillCurrent()) setError(message);
      completeComposition(false, message);
    } finally { finish(); }
  };

  const atCursor = imageInput ? currentPoints[0] : findImpactFramePointAtTime(currentPoints, Math.max(0, Math.min(time, duration - 0.08)));
  const allReady = currentPoints.length > 0 && currentPoints.every(canComposeImpactFrame);
  const canQueueGeneration = !!busy && queueInput?.sourceKey === sourceKey && queueInput?.pointId === frame?.id;

  return (
    <div data-skill-node={id} data-impact-frame-node={id} data-impact-progress={source ? overallProgress : 0} aria-busy={!!source && !!busy} className="mc-node-glass-shell relative w-[440px] rounded-2xl border border-violet-300/20 bg-[#1c1c1e] text-zinc-100 shadow-xl">
      <div className="mc-impact-frame-visual relative rounded-[inherit]">
      {!!source && !!busy && <NodeProgressBorder progress={overallProgress} borderRadius={16} />}
      <header className="flex items-center gap-2 border-b border-white/10 px-4 py-3">
        <Zap className="h-4 w-4 text-violet-200" />
        <span className="flex-1 text-sm font-medium">{data.label || '一键冲击帧'}</span>
        <span className="text-[10px] text-violet-200/80">技巧 Skill</span>
        <button type="button" aria-label={expanded ? '收起冲击帧面板' : '展开冲击帧面板'} aria-expanded={expanded} onClick={() => setExpanded((value) => !value)} className="nodrag nopan rounded p-1 hover:bg-white/10"><ChevronDown size={16} className={expanded ? 'rotate-180' : ''} /></button>
      </header>
      {expanded ? <div className="nodrag nopan nowheel max-h-[760px] space-y-4 overflow-y-auto overscroll-contain p-4">
        <div className="flex gap-1 rounded-lg bg-black/25 p-1" role="group" aria-label="冲击帧模式">
          {(['default', 'advanced'] as const).map((value) => <button key={value} type="button" data-impact-mode={value} aria-pressed={mode === value} disabled={!!busy} onClick={() => updateNodeData(id, { impactMode: value })} className={`nodrag nopan flex-1 rounded-md px-3 py-2 text-xs disabled:opacity-40 ${mode === value ? 'bg-violet-400/20 text-violet-100' : 'text-zinc-400 hover:bg-white/5'}`}>{value === 'default' ? '默认模式' : '高级模式'}</button>)}
        </div>
        <section className="space-y-2">
          <p className="text-xs font-medium">{imageInput ? '1 · 输入参考图片' : '1 · 选取打击瞬间'}</p>
          {sources.length > 1 && <select aria-label="输入素材" className={`${controlClass} w-full`} disabled={!!busy} value={source?.nodeId} onChange={(event) => updateNodeData(id, { impactSourceNodeId: event.target.value })}>{sources.map((item) => <option key={item.nodeId} value={item.nodeId}>{getMaterialReferenceKind(item) === 'image' ? '图片' : '视频'} · {item.fileName || item.slug}</option>)}</select>}
          {imageInput && sourceUrl ? <p data-impact-image-source className="rounded-lg border border-white/10 bg-black/20 p-3 text-xs leading-5 text-zinc-400">已将输入图片作为冲击帧参考，无需截帧，可直接生成并合成视频。</p> : videoUrl ? <>
            <video key={videoUrl} ref={videoRef} src={videoUrl} controls playsInline preload="auto" className="aspect-video w-full rounded-lg bg-black object-contain"
              onLoadedMetadata={(event) => {
                const video = event.currentTarget;
                setVideoMetadata({ key: sourceKey, url: videoUrl, duration: video.duration });
                const next = currentFrame ? frame!.time : 0;
                setTime(next); video.currentTime = next;
              }}
              onTimeUpdate={(event) => setTime(event.currentTarget.currentTime)}
              onError={() => {
                const message = '视频无法解码，请检查素材格式或重新导入';
                setError(message);
                setPrepared((value) => value.key === sourceKey ? { ...value, error: message } : value);
              }}
            />
            <p className="text-[10px] text-zinc-400">拖动胶片选帧 · 点击截取点编辑</p>
            <ImpactFrameTimeline videoUrl={videoUrl} duration={duration} time={time} points={currentPoints} activePointId={currentFrame ? frame?.id : undefined} disabled={!!busy} onSeek={seek} onSelectPoint={(pointId) => {
              const point = currentPoints.find((item) => item.id === pointId);
              if (point) selectPoint(point, true);
            }} />
            <button type="button" data-impact-capture className={`${actionClass} w-full ${busy === 'capture' ? 'mc-impact-processing-button' : ''}`} disabled={!!busy || !duration} onClick={() => void capture()}>{busy === 'capture' ? `正在截取 · ${overallProgress}%` : <><Scissors size={13} />{atCursor ? '已截取此位置' : '添加截取点'}</>}</button>
          </> : <div className="flex min-h-36 flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-white/15 bg-black/20 p-4 text-center text-xs text-zinc-400"><Film size={22} />{!source ? '将图片或视频节点连线到左侧输入点' : sourceError ? unwrapNodeError(sourceError) : (imageInput ? '正在读取图片…' : '正在读取视频…')}{sourceError && <button type="button" className={actionClass} onClick={() => { setPrepared({ key: '', url: '', error: '' }); setRetry((value) => value + 1); }}>重试读取</button>}</div>}
        </section>
        {(sourceUrl || frame) && <div className="grid min-w-0 grid-cols-2 gap-2">
          <label className="min-w-0 cursor-default select-none space-y-1.5 text-[10px] text-zinc-400"><span>生成厂商</span>
            <select aria-label="冲击帧图片厂商" className={`${controlClass} w-full min-w-0 cursor-default select-none truncate`} disabled={!!busy || !providers.length} value={selectedProvider} onChange={(event) => {
              const first = models.find((model) => model.providerId === event.target.value);
              if (first) updateNodeData(id, { impactImageModel: first.value });
            }}>
              {selectedProvider && !providers.some(([providerId]) => providerId === selectedProvider) && <option value={selectedProvider}>原厂商不可用，请重新选择</option>}
              {providers.length ? providers.map(([providerId, label]) => <option key={providerId} value={providerId}>{label}</option>) : <option value="">暂无可用厂商</option>}
            </select>
          </label>
          <label className="min-w-0 cursor-default select-none space-y-1.5 text-[10px] text-zinc-400"><span>生成模型</span>
            <select aria-label="冲击帧图片模型" className={`${controlClass} w-full min-w-0 cursor-default select-none truncate`} disabled={!!busy || !providerModels.length} value={selectedModel} onChange={(event) => updateNodeData(id, { impactImageModel: event.target.value })}>
              {selectedModel && !modelAvailable && <option value={selectedModel}>原模型不可用，请重新选择</option>}
              {providerModels.length ? providerModels.map((model) => <option key={model.value} value={model.value}>{model.modelLabel}</option>) : <option value="">暂无可用图生图模型</option>}
            </select>
          </label>
          {!models.length && <p className="col-span-2 text-[10px] leading-4 text-amber-200/80">请先在 API 配置中启用并配置图生图厂商。</p>}
        </div>}
        {mode === 'advanced' && (sourceUrl || frame) && <div ref={modePickerRef} className="relative space-y-2" data-impact-generation-controls>
          <p className="text-[10px] text-zinc-400">生成模式</p>
          <div className="grid grid-cols-5 gap-1" role="group" aria-label="冲击图生成模式">
            {IMPACT_FRAME_GENERATION_MODES.map((option) => <button key={option.value} type="button" data-impact-generation-mode={option.value} aria-pressed={generationMode === option.value}
              aria-expanded={option.value === 'mixed' ? mixedPickerOpen : undefined} aria-haspopup={option.value === 'mixed' ? 'dialog' : undefined}
              disabled={!!busy || !frame || !currentFrame} className={`${actionClass} whitespace-nowrap px-1 text-[10px] ${generationMode === option.value ? 'border-violet-300/60 bg-violet-400/15 text-violet-100' : 'text-zinc-400'}`}
              onClick={() => {
                if (generationMode !== option.value) changeGenerationMode(option.value);
                setMixedPickerPointId(option.value === 'mixed' && frame ? mixedPickerOpen ? null : frame.id : null);
              }}>{option.label}</button>)}
          </div>
          <p className="text-[10px] leading-4 text-zinc-500">{frame ? modeDescriptions[generationMode] : imageInput ? '图片读取完成后可选择生成模式。' : '添加截取点后可选择生成模式。'}</p>
          {mixedPickerOpen && <div role="dialog" aria-label="选择混合模式" className="absolute inset-x-0 top-full z-40 mt-2 space-y-3 rounded-xl border border-white/15 bg-[#252527] p-3 shadow-xl">
            <div className="flex items-center justify-between gap-2 text-[11px] text-zinc-300"><span>参与混合的模式（至少选择一项）</span><button type="button" className="rounded px-2 py-1 hover:bg-white/10" onClick={() => setMixedPickerPointId(null)}>完成</button></div>
            <div className="grid grid-cols-2 gap-2">
              {baseModeOptions.map((option) => <label key={option.value} className="flex items-center gap-2 rounded-lg bg-black/20 px-3 py-2 text-xs text-zinc-200">
                <input type="checkbox" data-impact-mixed-mode={option.value} checked={mixedModes.includes(option.value)} disabled={!!busy || mixedModes.length === 1 && mixedModes[0] === option.value}
                  className="nodrag nopan accent-violet-300" onChange={(event) => changeGenerationMode('mixed', event.target.checked ? [...mixedModes, option.value] : mixedModes.filter((value) => value !== option.value))} />{option.label}
              </label>)}
            </div>
          </div>}
        </div>}
        {source && mode === 'default' && <p className="text-xs leading-5 text-zinc-400">{imageInput ? '点击合成，参考输入图片自动生成 6 张不同颜色风格的冲击图片并输出视频；已有高级编辑会保留。' : '选好画面后点击合成，自动生成 6 张不同颜色风格的冲击图片并输出视频。可添加多个截取点一起合成；已有高级编辑会保留。'}</p>}
        {frame && <>
          <section className="space-y-2">
            <div className="flex items-center justify-between gap-2"><p className="text-xs font-medium">{frame.sourceImageUrl ? '冲击帧参考图片' : `截取点 ${currentPoints.findIndex((point) => point.id === frame.id) + 1} · ${frame.time.toFixed(3)}s`}</p>{!frame.sourceImageUrl && <button type="button" data-impact-delete-point aria-label="删除当前截取点" title="删除当前截取点" disabled={!!busy} className={`${actionClass} text-zinc-400`} onClick={removePoint}><Trash2 size={12} /></button>}</div>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img data-impact-frame-preview src={resolveMaterialPlayableUrl(frame.frameUrl)} alt="已确认的冲击帧参考画面" className="block h-auto w-full rounded-lg" width={frame.width} height={frame.height} />
            {mode === 'default' ? <p className="text-xs text-violet-200/80">{frame.slots.filter((slot) => slot.imageUrl && !slot.error).length} / {frame.slots.length} 张已生成 · 合成时自动补齐</p> : <>
            <div className="flex items-center justify-between gap-2"><label htmlFor={`impact-count-${id}`} className="text-xs text-zinc-300">图片数量（最多 50 张）</label><select id={`impact-count-${id}`} aria-label="冲击图片数量" className={controlClass} value={frame.slots.length} disabled={!!busy} onChange={(event) => patchPoint(frame.id, { slots: resizeImpactFrameSlots(frame.slots, Number(event.target.value), { generationMode, mixedModes }) })}>{Array.from({ length: IMPACT_FRAME_MAX_IMAGES }, (_, i) => <option key={i + 1} value={i + 1}>{i + 1} 张</option>)}</select></div>
            <div data-impact-speed-control className={`cursor-default select-none space-y-1.5 ${busy ? 'opacity-40' : ''}`}>
              <label htmlFor={`impact-speed-${id}`} className="text-xs text-zinc-300">冲击帧速度</label>
              <div className="relative h-6">
                <div aria-hidden="true" className="pointer-events-none absolute inset-x-2 top-3 h-0.5 bg-white/20">
                  {speedOptions.map((option, index) => <span key={option.value} className="absolute top-1/2 h-2 w-2 -translate-x-1/2 -translate-y-1/2 rounded-full border border-zinc-400 bg-zinc-600" style={{ left: `${index * 50}%` }} />)}
                </div>
                <input id={`impact-speed-${id}`} aria-label="冲击帧速度" aria-valuetext={speedOptions[speedIndex].label} type="range" min={0} max={2} step={1} value={speedIndex} disabled={!!busy}
                  onChange={(event) => patchPoint(frame.id, { speed: speedOptions[Number(event.target.value)].value })}
                  onKeyDown={(event) => event.stopPropagation()}
                  className="nodrag nopan relative m-0 h-6 w-full cursor-default appearance-none rounded-md bg-transparent outline-none focus-visible:ring-2 focus-visible:ring-violet-300/70 [&::-webkit-slider-runnable-track]:h-0.5 [&::-webkit-slider-runnable-track]:bg-transparent [&::-webkit-slider-thumb]:-mt-[7px] [&::-webkit-slider-thumb]:h-4 [&::-webkit-slider-thumb]:w-4 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:border-2 [&::-webkit-slider-thumb]:border-violet-200 [&::-webkit-slider-thumb]:bg-violet-400 [&::-moz-range-track]:h-0.5 [&::-moz-range-track]:bg-transparent [&::-moz-range-thumb]:h-3 [&::-moz-range-thumb]:w-3 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:border-2 [&::-moz-range-thumb]:border-violet-200 [&::-moz-range-thumb]:bg-violet-400" />
              </div>
              <div aria-hidden="true" className="relative mx-2 h-4 text-[11px]">
                {speedOptions.map((option, index) => <span key={option.value} className={`absolute -translate-x-1/2 ${speedIndex === index ? 'font-medium text-violet-200' : 'text-zinc-500'}`} style={{ left: `${index * 50}%` }}>{option.label}</span>)}
              </div>
            </div>
            <div className="flex items-center justify-between gap-2"><label htmlFor={`impact-transition-${id}`} className="text-xs text-zinc-300">冲击图转场方式</label><select id={`impact-transition-${id}`} aria-label="冲击图转场方式" className={controlClass} value={frame.transition || 'dissolve'} disabled={!!busy} onChange={(event) => patchPoint(frame.id, { transition: event.target.value as ImpactFrameTransition })}><option value="cut">直切</option><option value="dissolve">叠化渐变</option><option value="flash-black">闪黑</option><option value="flash-white">闪白</option></select></div>
            <button type="button" data-impact-generate-all className={`${actionClass} w-full ${busy ? 'mc-impact-processing-button' : ''}`} disabled={!!busy || !currentFrame || !sourceUrl || !modelAvailable || frame.slots.every((slot) => slot.imageUrl && !slot.error)} onClick={() => void generate()}>{!busy && <Sparkles size={13} />}{busy ? `正在处理 · ${overallProgress}%` : '生成全部待生成图片'}</button>
            <div className="grid grid-cols-2 gap-2">
              {frame.slots.map((slot, index) => {
                const job = slotProgress[`${frame.id}:${slot.id}`];
                const generating = job?.status === 'running';
                return <div key={slot.id} data-impact-slot={slot.id} data-impact-slot-progress={job?.progress} className="relative space-y-2 rounded-xl border border-white/10 bg-black/15 p-2">
                <div className="flex items-center justify-between gap-1 text-[10px] text-zinc-400"><span>冲击图 {index + 1}</span><span className="text-zinc-500">{baseModeOptions.find((option) => option.value === (slot.generationMode || 'multicolor'))?.label}</span></div>
                <div className="relative flex aspect-video items-center justify-center overflow-hidden rounded-md bg-black/40">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  {slot.imageUrl ? <img src={resolveMaterialPlayableUrl(slot.imageUrl)} alt={`冲击图 ${index + 1}`} className="h-full w-full object-contain" /> : <span className="text-[10px] text-zinc-500">{job?.status === 'queued' ? '排队中…' : '待生成图片'}</span>}
                  {generating && <NodeGenerationOverlay progress={job.progress} label={`冲击图 ${index + 1} 生成中`} continuityKey={`impact:${id}:${frame.id}:${slot.id}:${runId}`} />}
                  {slot.imageUrl && <ImpactFrameZoomButton imageUrl={slot.imageUrl} label={`冲击图 ${index + 1}`} />}
                </div>
                <textarea aria-label={`冲击图 ${index + 1} 提示词`} className={`${controlClass} nowheel h-24 w-full resize-y text-[11px] leading-4`} value={slot.prompt} disabled={!!busy} onChange={(event) => patchSlot(frame.id, slot.id, { prompt: event.target.value })} />
                {slot.error && <p role="alert" className="break-words text-[10px] leading-4 text-red-300">{unwrapNodeError(slot.error)}</p>}
                <div className="flex gap-1.5">
                  <button type="button" data-impact-generate={slot.id} className={`${actionClass} min-w-0 flex-1 whitespace-nowrap px-1.5 text-[11px] ${generating ? 'mc-impact-processing-button' : ''}`} disabled={(!!busy && !canQueueGeneration) || !!job || !currentFrame || !sourceUrl || !modelAvailable || !slot.prompt.trim()} onClick={() => void generate(slot.id)}>{generating ? `正在处理 · ${job.progress}%` : job?.status === 'queued' ? '排队中' : slot.imageUrl ? '重新生成' : '生成图片'}</button>
                  <ImpactFrameReplaceButton disabled={!!busy || !currentFrame} onReplace={(url) => replaceSlotImage(frame, slot.id, url)} />
                </div>
              </div>; })}
            </div>
            </>}
          </section>
        </>}
        {(sourceUrl || frame) && <section className="space-y-2 border-t border-white/10 pt-3">
            <p className="text-xs text-zinc-300">{imageInput ? '将当前冲击图片合成为视频' : `合成当前视频的全部截取点 · 已添加 ${currentPoints.length} 个`}</p>
            {mode === 'default' && <p className="text-[10px] leading-5 text-zinc-400">{imageInput ? '快速闪播，每张 1 帧，最多 6 张图片同时生成。输出独立冲击帧视频。' : '快速闪播，每张 1 帧。最多 6 张图片同时生成，保留原视频时长与音轨。靠近片尾时闪播区间会适当前移。'}</p>}
            {mode === 'advanced' && currentPoints.length > 0 && !allReady && <p className="text-[10px] text-amber-200/80">{imageInput ? '请先生成全部冲击图片，或切换默认模式自动完成。' : '请先生成每个截取点的全部图片，或切换默认模式自动完成。'}</p>}
            <button type="button" data-impact-compose className={`${actionClass} w-full border-violet-300/30 bg-violet-400/15 text-violet-100 ${busy ? 'mc-impact-processing-button' : ''}`} disabled={!!busy || !sourceUrl || (!imageInput && !duration) || (imageInput && !currentFrame) || (mode === 'advanced' ? !allReady : !modelAvailable && !(allReady && atCursor))} onClick={() => void compose()}>{!busy && <Film size={14} />}{busy ? `正在处理 · ${overallProgress}%` : mode === 'default' ? '一键合成并输出视频' : imageInput ? '合成冲击图片并输出视频' : '合成全部截取点并输出'}</button>
          </section>}
        {source && progress && <p role="status" className="text-xs leading-5 text-violet-200">{progress}</p>}
        {source && error && <p role="alert" className="text-xs leading-5 text-red-300">{unwrapNodeError(error)}</p>}
        {source && notice && <p role="status" className="text-xs leading-5 text-violet-200">{notice}</p>}
      </div> : <p className="px-4 py-3 text-xs text-zinc-400">{currentPoints.length ? `${mode === 'default' ? '默认' : '高级'}模式 · ${imageInput ? '图片参考' : `${currentPoints.length} 个截取点`}` : '连接图片或视频，展开面板制作冲击帧'}</p>}
      </div>
      <Handle type="target" position={Position.Left} className="mc-node-handle" />
      <Handle type="source" position={Position.Right} className="mc-node-handle" />
    </div>
  );
}

export default memo(ImpactFrameNode);
