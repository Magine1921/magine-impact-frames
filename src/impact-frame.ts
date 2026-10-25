export const IMPACT_FRAME_SKILL_ID = 'canvas-technique-impact-frames';
import type { ImpactFrameSpeed, ImpactFrameTransition } from './impact-frame-video.js';
export type { ImpactFrameSpeed, ImpactFrameTransition } from './impact-frame-video.js';

export const IMPACT_FRAME_MAX_IMAGES = 50;
export const IMPACT_FRAME_DEFAULT_IMAGES = 6;
export type ImpactFrameMode = 'default' | 'advanced';
export type ImpactFrameGenerationMode = 'multicolor' | 'background' | 'subject' | 'reconstruct' | 'mixed';
export type ImpactFrameBaseMode = Exclude<ImpactFrameGenerationMode, 'mixed'>;
export const IMPACT_FRAME_GENERATION_MODES = [
  { value: 'multicolor', label: '多色图' },
  { value: 'background', label: '仅换背景' },
  { value: 'subject', label: '仅变主体' },
  { value: 'reconstruct', label: '参考重构' },
  { value: 'mixed', label: '混合' },
] as const;

export interface ImpactFrameSlot {
  id: string;
  prompt: string;
  imageUrl?: string;
  error?: string;
  generationMode?: ImpactFrameBaseMode;
  variationIndex?: number;
  defaultPrompt?: string;
}

export interface ImpactFrameState {
  sourceNodeId: string;
  sourceVideoUrl: string;
  sourceImageUrl?: string;
  frameUrl: string;
  time: number;
  width: number;
  height: number;
  slots: ImpactFrameSlot[];
  speed?: ImpactFrameSpeed;
  transition?: ImpactFrameTransition;
  generationMode?: ImpactFrameGenerationMode;
  mixedModes?: ImpactFrameBaseMode[];
}

export interface ImpactFramePoint extends ImpactFrameState {
  id: string;
}

/** Older projects stored one frame; keep its edits when first opening the multi-point editor. */
export function getImpactFramePoints(data: { impactFrames?: ImpactFramePoint[]; impactFrame?: ImpactFrameState }): ImpactFramePoint[] {
  if (data.impactFrames) return data.impactFrames;
  return data.impactFrame ? [{ ...data.impactFrame, id: 'impact-legacy' }] : [];
}

export function findImpactFramePointAtTime(points: ImpactFramePoint[], time: number): ImpactFramePoint | undefined {
  return points.find((point) => Math.abs(point.time - time) < 0.02);
}

export function isImpactFrameSkill(data: Record<string, unknown>): boolean {
  return data.type === 'skill' && data.skillId === IMPACT_FRAME_SKILL_ID;
}

const PALETTES = [
  '纯黑与纯白，白底黑色剪影，极强明暗对比，放射状墨线爆发',
  '品红与纯黑，黑底亮品红边缘，电光与飞散墨迹',
  '明黄与深紫，灼烧般的黄色高光，紫黑阴影，锐利速度线',
  '荧光绿与纯黑，绿黑反相，碎裂状能量与硬边剪影',
  '电蓝与炽橙，蓝色暗部和橙色亮部，爆炸放射线',
  '猩红与纯白，白底红色爆裂线条，黑色重阴影',
  '纯白与深黑，黑底白色人物轮廓，闪电与高反差负片效果',
  '青色与品红，大块双色分离，硬边色块与速度线',
  '金黄与纯黑，金色剪影边缘，锐利黑色冲击裂纹',
  '冷白与靛蓝，白色闪光，蓝黑色剪影和密集能量线',
];

const MODE_CONSTRAINTS: Record<ImpactFrameBaseMode, string> = {
  multicolor: '保持参考人物身份、样貌、姿态、动作、构图和镜头位置不变；通过高反差色彩、明暗和冲击线条制作多色冲击帧。',
  background: '仅换背景：只将参考画面中央的主要人物或对象识别为受保护主体，按该主体的完整轮廓保留，即使其身体或部件延伸到画面中央区域之外也必须完整保护，不得改选旁边的人物或物体。中央主体的样貌、五官、发型、服装、姿态、颜色、明暗、位置、尺寸与遮挡边界不变。参考中可见的头脸、四肢、衣服、装备与其他部件必须完整，不得误抠、遗漏或形成缺口；保留参考原有的真实遮挡和画外截断，不把这些视为缺失，不得凭空补出肢体。输出前检查主体完整性，如出现非原有缺失须先修补再输出。其余人物和物体不作为受保护主体，可作为场景背景处理，不要沿用保护所有前景主体的要求。所有改动仅限背景区域，禁止给主体着色、重绘、加滤镜或叠加特效。',
  subject: '仅变主体：只将参考画面中央的主要人物或对象识别为修改对象，按该主体的完整轮廓处理，即使其身体或部件延伸到画面中央区域之外也属于同一主体，不得改选旁边的人物或物体。完整保留中央主体之外的全部画面，包括背景及其余人物、物体，其内容、颜色、光照、纹理、透视和位置不变；其他人物和物体不得作为修改对象。只修改中央主体的服装、装备、材质与局部特效；原主体身份、样貌、五官、发型轮廓、身体比例、姿态、位置及遮挡边界不变，禁止换脸或修改背景。参考中可见的头脸、四肢、衣服、装备与其他部件必须完整，不得误抠、遗漏或形成缺口；保留参考原有的真实遮挡和画外截断，不把这些视为缺失，不得凭空补出肢体。输出前检查主体完整性，如出现非原有缺失须先修补再输出。',
  reconstruct: '参考重构：以参考画面中主体与背景的构图关系、相对位置、尺度、姿态、遮挡、透视和镜头方向为依据，重新设计主体的服装装备与背景环境，形成全新场景；原主体身份、样貌、五官、发型轮廓和身体比例必须保持不变，禁止换脸或替换人物身份。',
};

const SUBJECT_COMPLETENESS = `【最高优先级：中央主体完整，禁止误抠与缺失】
只识别参考画面中央的主要人物或对象，必须按其完整轮廓处理；延伸到画面中央区域之外的身体和部件也属于同一主体，不得错选旁边的人物或物体。
主体原图中可见的头发、脸部、肢体、手指、衣物、盔甲、饰品、武器、手持物及其他部件必须完整、连续。严禁误抠除、吞边、断肢、残缺、透明孔洞、背景穿透主体或遗漏附属物。
保留原图真实的遮挡、透视和画外裁切，不凭空补出不可见肢体；在本次生图中补全误抠造成的可见元素缺失后再输出。按当前模式允许改变的颜色、服装、装备和背景进行设计，完整性要求优先于冲突的风格描述。`;

const BACKGROUNDS = ['碎裂的黑曜石峡谷', '暴雨中的霓虹都市', '漂浮晶体构成的空间', '赤红熔岩的废墟', '冰蓝色极地遗迹', '银白闪电贯穿的云海', '金色沙暴中的古城', '紫色星云与行星碎片', '荧光植物覆盖的森林', '水墨飞溅的抽象战场'];
const SUBJECT_STYLES = ['磨损的银色机械甲胄', '黑金分层武士铠甲', '半透明冰晶护甲', '深红熔岩纹理战衣', '青蓝全息纤维服装', '白色陶瓷机械外骨骼', '紫色棱镜金属装备', '古铜色蒸汽机械装束', '黑色碳纤维与荧光缝线', '金色流光织物与轻甲'];
const BACKGROUND_VARIATIONS = ['背景采用硬边放射状光束', '背景采用碎片化几何冲击波', '背景采用环形能量涟漪', '背景采用交错的速度线与粒子流', '背景采用层叠的裂纹与剪纸状块面'];
const SUBJECT_VARIATIONS = ['服装材质呈现锐利镜面高光', '装备表面呈现沿轮廓流动的能量纹路', '衣料与护甲呈现粗粝雕刻纹理', '装备接缝呈现细小发光电弧', '服装呈现层叠镭射薄片质感'];
const MULTICOLOR_VARIATIONS = ['', '反转主体与背景明暗，使用密集细线和粗粝网点纹理。', '强化白色高光闪电与碎裂墨点，形成闪光峰值。', '以同心能量环和断裂的几何色块构成冲击波，使用干笔飞白纹理。', '采用交错光栅条纹与锋利多边形碎屑，加入套色错位和刮痕效果。'];

function defaultImpactFramePrompt(mode: ImpactFrameBaseMode, index: number): string {
  const variation = Math.floor(index / PALETTES.length) % MULTICOLOR_VARIATIONS.length;
  if (mode === 'multicolor') {
    return `${SUBJECT_COMPLETENESS}\n\n以参考画面制作一张打击瞬间的冲击帧。保持人物身份、姿态、动作、构图和镜头位置不变。${PALETTES[index % PALETTES.length]}。${MULTICOLOR_VARIATIONS[variation]}动漫作画感，二值化硬边，高饱和高反差，强调打击点。只输出一张完整画面，无文字、无水印、无拼图。`;
  }
  const background = `${BACKGROUNDS[index % BACKGROUNDS.length]}，${BACKGROUND_VARIATIONS[variation]}`;
  const subject = `${SUBJECT_STYLES[index % SUBJECT_STYLES.length]}，${SUBJECT_VARIATIONS[variation]}`;
  const design = mode === 'background' ? `将背景设计为${background}。`
    : mode === 'subject' ? `将主体的服装与装备设计为${subject}。`
      : `新背景为${background}；主体的新服装与装备为${subject}。`;
  return `${SUBJECT_COMPLETENESS}\n\n以参考截帧制作一张打击瞬间的冲击图。${MODE_CONSTRAINTS[mode]}${design}强调打击瞬间的张力。只输出一张完整画面，无文字、无水印、无拼图。`;
}

function assignGenerationModes(count: number, mode: ImpactFrameGenerationMode, mixedModes?: ImpactFrameBaseMode[], previous?: ImpactFrameBaseMode): ImpactFrameBaseMode[] {
  if (mode !== 'mixed') return Array.from({ length: count }, () => mode);
  const available = IMPACT_FRAME_GENERATION_MODES.flatMap(({ value }) => value !== 'mixed' && (!mixedModes?.length || mixedModes.includes(value)) ? [value] : []);
  const result: ImpactFrameBaseMode[] = [];
  while (result.length < count) {
    const batch = [...available];
    for (let index = batch.length - 1; index > 0; index -= 1) {
      const target = Math.floor(Math.random() * (index + 1));
      [batch[index], batch[target]] = [batch[target], batch[index]];
    }
    const last = result.at(-1) ?? previous;
    if (batch.length > 1 && batch[0] === last) [batch[0], batch[1]] = [batch[1], batch[0]];
    result.push(...batch.slice(0, count - result.length));
  }
  return result;
}

export function resizeImpactFrameSlots(slots: ImpactFrameSlot[], count = IMPACT_FRAME_DEFAULT_IMAGES, options: { generationMode?: ImpactFrameGenerationMode; mixedModes?: ImpactFrameBaseMode[] } = {}): ImpactFrameSlot[] {
  const size = Math.max(1, Math.min(IMPACT_FRAME_MAX_IMAGES, Number.isFinite(count) ? Math.floor(count) : IMPACT_FRAME_DEFAULT_IMAGES));
  const modes = assignGenerationModes(Math.max(0, size - slots.length), options.generationMode || 'multicolor', options.mixedModes, slots.at(-1)?.generationMode);
  return Array.from({ length: size }, (_, index) => {
    if (slots[index]) return slots[index];
    const generationMode = modes[index - slots.length];
    const prompt = defaultImpactFramePrompt(generationMode, index);
    return { id: `impact-${index + 1}`, prompt, defaultPrompt: prompt, generationMode, variationIndex: index };
  });
}

/** Switching a preset never discards a user's prompt edits or completed images. */
export function applyImpactFrameGenerationMode(slots: ImpactFrameSlot[], mode: ImpactFrameGenerationMode, mixedModes?: ImpactFrameBaseMode[]): ImpactFrameSlot[] {
  const modes = assignGenerationModes(slots.length, mode, mixedModes);
  return slots.map((slot, index) => {
    const variationIndex = slot.variationIndex ?? index;
    const previousPrompt = slot.defaultPrompt ?? defaultImpactFramePrompt(slot.generationMode || 'multicolor', variationIndex);
    const defaultPrompt = defaultImpactFramePrompt(modes[index], variationIndex);
    return { ...slot, generationMode: modes[index], variationIndex, defaultPrompt, prompt: slot.prompt === previousPrompt ? defaultPrompt : slot.prompt };
  });
}

export function buildImpactFrameGenerationPrompt(slot: ImpactFrameSlot): string {
  const prompt = slot.prompt.startsWith(SUBJECT_COMPLETENESS) ? slot.prompt : `${SUBJECT_COMPLETENESS}\n\n${slot.prompt}`;
  return `${prompt}\n\n当前生成模式的硬性限制（优先于上述提示词中冲突的描述）：${MODE_CONSTRAINTS[slot.generationMode || 'multicolor']}`;
}

export function isImpactFrameSourceCurrent(frame: ImpactFrameState | undefined, sourceNodeId?: string, sourceUrl?: string, sourceKind: 'image' | 'video' = 'video'): boolean {
  return Boolean(frame?.frameUrl && sourceNodeId && sourceUrl
    && frame.sourceNodeId === sourceNodeId && (sourceKind === 'image' ? frame.sourceImageUrl : frame.sourceVideoUrl) === sourceUrl);
}

export function canComposeImpactFrame(frame: ImpactFrameState | undefined): boolean {
  return Boolean(frame?.frameUrl && frame.slots.length >= 1 && frame.slots.length <= IMPACT_FRAME_MAX_IMAGES
    && frame.slots.every((slot) => slot.imageUrl && !slot.error));
}
