import assert from 'node:assert/strict';
import test from 'node:test';
import { applyImpactFrameGenerationMode, buildImpactFrameGenerationPrompt, canComposeImpactFrame, findImpactFramePointAtTime, getImpactFramePoints, IMPACT_FRAME_GENERATION_MODES, isImpactFrameSkill, isImpactFrameSourceCurrent, resizeImpactFrameSlots } from '../dist/impact-frame.js';

test('image count is bounded and existing prompts/images survive count increases', () => {
  const slots = resizeImpactFrameSlots([], 5);
  assert.equal(slots.length, 5);
  assert.equal(new Set(slots.map((slot) => slot.prompt)).size, 5);
  assert.equal(new Set(slots.map((slot) => slot.id)).size, 5);
  const edited = slots.map((slot, index) => index ? slot : { ...slot, prompt: '用户提示词', imageUrl: '/one.png' });
  const fifty = resizeImpactFrameSlots(edited, 100);
  assert.equal(fifty.length, 50);
  assert.equal(fifty[0], edited[0]);
  assert.equal(new Set(fifty.map((slot) => slot.prompt)).size, 50);
  assert.equal(fifty.some((slot) => slot.prompt.includes('undefined')), false);
  assert.equal(resizeImpactFrameSlots(fifty, 0).length, 1);
  assert.equal(resizeImpactFrameSlots([], NaN).length, 6);
  assert.equal(resizeImpactFrameSlots([]).length, 6);
  assert.equal(new Set(resizeImpactFrameSlots([]).map((slot) => slot.prompt)).size, 6);
});

test('all four presets have 50 distinct visual variants and multicolor keeps existing styles', () => {
  for (const { value } of IMPACT_FRAME_GENERATION_MODES.filter(({ value }) => value !== 'mixed')) {
    const slots = resizeImpactFrameSlots([], 50, { generationMode: value });
    assert.equal(slots.length, 50);
    assert.equal(new Set(slots.map(({ prompt }) => prompt)).size, 50, value);
    assert.ok(slots.every((slot, index) => slot.generationMode === value && slot.variationIndex === index && slot.defaultPrompt === slot.prompt));
  }
  const multicolor = resizeImpactFrameSlots([], 50);
  assert.ok(multicolor[0].prompt.endsWith('以参考画面制作一张打击瞬间的冲击帧。保持人物身份、姿态、动作、构图和镜头位置不变。纯黑与纯白，白底黑色剪影，极强明暗对比，放射状墨线爆发。动漫作画感，二值化硬边，高饱和高反差，强调打击点。只输出一张完整画面，无文字、无水印、无拼图。'));
  assert.match(multicolor[10].prompt, /反转主体与背景明暗，使用密集细线和粗粝网点纹理/);
  assert.match(multicolor[20].prompt, /强化白色高光闪电与碎裂墨点，形成闪光峰值/);
  assert.match(multicolor[30].prompt, /同心能量环/);
  assert.match(multicolor[40].prompt, /交错光栅条纹/);
});

test('preset changes preserve manual edits, completed images and retries while updating default prompts', () => {
  const initial = resizeImpactFrameSlots([], 4);
  const slots = initial.map((slot, index) => ({ ...slot, ...(index === 0 ? { prompt: '用户自定义红色战袍', imageUrl: '/custom.png' } : {}), ...(index === 1 ? { error: '重试失败', imageUrl: '/existing.png' } : {}) }));
  const before = structuredClone(slots);
  const background = applyImpactFrameGenerationMode(slots, 'background');
  assert.deepEqual(slots, before, 'Preset changes do not mutate live input');
  assert.equal(background[0].prompt, slots[0].prompt);
  assert.equal(background[0].imageUrl, '/custom.png');
  assert.equal(background[1].imageUrl, '/existing.png');
  assert.equal(background[1].error, '重试失败');
  assert.match(background[1].prompt, /仅换背景/);
  assert.doesNotMatch(background[1].prompt, /多色冲击帧|二值化硬边/);
  const subject = applyImpactFrameGenerationMode(background, 'subject');
  assert.equal(subject[0].prompt, slots[0].prompt);
  assert.match(subject[1].prompt, /仅变主体/);
  const restored = applyImpactFrameGenerationMode(subject, 'multicolor');
  assert.equal(restored[1].prompt, initial[1].prompt);
  const legacy = initial.map(({ id, prompt }) => ({ id, prompt }));
  assert.match(applyImpactFrameGenerationMode(legacy, 'reconstruct')[0].prompt, /参考重构/);
});

test('mixed images use selected modes once per shuffled round without adjacent duplicates', () => {
  const selected = ['background', 'subject', 'reconstruct'];
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const slots = resizeImpactFrameSlots([], 50, { generationMode: 'mixed', mixedModes: selected });
    assert.ok(slots.every(({ generationMode }) => selected.includes(generationMode)));
    assert.equal(new Set(slots.map(({ prompt }) => prompt)).size, 50);
    for (let index = 1; index < slots.length; index += 1) assert.notEqual(slots[index].generationMode, slots[index - 1].generationMode);
    for (let index = 0; index + selected.length <= slots.length; index += selected.length) {
      assert.deepEqual(slots.slice(index, index + selected.length).map(({ generationMode }) => generationMode).sort(), [...selected].sort());
    }
  }
  const single = resizeImpactFrameSlots([], 50, { generationMode: 'mixed', mixedModes: ['background'] });
  assert.ok(single.every(({ generationMode }) => generationMode === 'background'));
  assert.equal(new Set(single.map(({ prompt }) => prompt)).size, 50, 'One selected mode still has distinct image variants');
});

test('mixed slot assignments remain stable on resize, retry and serialized reload', () => {
  const options = { generationMode: 'mixed', mixedModes: ['multicolor', 'subject'] };
  const initial = resizeImpactFrameSlots([], 7, options);
  const before = structuredClone(initial);
  const resized = resizeImpactFrameSlots(initial, 50, options);
  assert.deepEqual(resized.slice(0, 7), before);
  assert.equal(resized[0], initial[0]);
  assert.notEqual(resized[7].generationMode, resized[6].generationMode);
  const restored = JSON.parse(JSON.stringify(resized));
  assert.deepEqual(resizeImpactFrameSlots(restored, 50, options), restored);
  assert.deepEqual(restored.map(buildImpactFrameGenerationPrompt), resized.map(buildImpactFrameGenerationPrompt));
});

test('all presets and mixed assignments put subject completeness first without duplicating it on generation', () => {
  const baseModes = ['multicolor', 'background', 'subject', 'reconstruct'];
  const presets = baseModes.flatMap((generationMode) => resizeImpactFrameSlots([], 2, { generationMode }));
  const mixed = resizeImpactFrameSlots([], 8, { generationMode: 'mixed', mixedModes: baseModes });
  assert.deepEqual([...new Set(mixed.map((slot) => slot.generationMode))].sort(), [...baseModes].sort());
  for (const slot of [...presets, ...mixed]) {
    const before = structuredClone(slot);
    const firstBlock = slot.prompt.split('\n\n')[0];
    assert.match(firstBlock, /^【最高优先级：中央主体完整，禁止误抠与缺失】/);
    assert.match(firstBlock, /完整轮廓处理.*中央区域之外/);
    assert.match(firstBlock, /手指、衣物、盔甲、饰品、武器、手持物/);
    assert.match(firstBlock, /严禁误抠除、吞边、断肢、残缺、透明孔洞、背景穿透主体或遗漏附属物/);
    assert.match(firstBlock, /保留原图真实的遮挡、透视和画外裁切，不凭空补出不可见肢体/);
    assert.match(firstBlock, /补全误抠造成的可见元素缺失后再输出/);
    assert.match(firstBlock, /完整性要求优先于冲突的风格描述/);
    const generated = buildImpactFrameGenerationPrompt(slot);
    const repeated = buildImpactFrameGenerationPrompt({ ...slot, prompt: generated });
    for (const prompt of [generated, repeated]) {
      assert.equal(prompt.split('\n\n')[0], firstBlock);
      assert.equal(prompt.split('【最高优先级：中央主体完整，禁止误抠与缺失】').length - 1, 1);
      assert.ok(prompt.includes(slot.prompt), 'Generation retains the selected visual style');
    }
    assert.deepEqual(slot, before, 'Generation leaves saved prompt text and images untouched');
  }
});

test('provider prompts select the complete central subject while overriding saved and custom scope conflicts', () => {
  for (const prompt of ['用户自定义：整个画面变红，替换人物样貌，修改两侧人物', '仅换背景：完整保留参考画面的所有前景主体，主体的样貌、五官、发型、服装、姿态、颜色、明暗、位置、尺寸与遮挡边界不变。']) {
    const slot = { id: 'one', prompt, defaultPrompt: prompt, imageUrl: '/saved.png' };
    const before = structuredClone(slot);
    const background = buildImpactFrameGenerationPrompt({ ...slot, generationMode: 'background' });
    const subject = buildImpactFrameGenerationPrompt({ ...slot, generationMode: 'subject' });
    for (const finalPrompt of [background, subject]) {
      assert.match(finalPrompt, /^【最高优先级：中央主体完整，禁止误抠与缺失】/);
      assert.ok(finalPrompt.includes(`\n\n${prompt}\n\n`), 'Saved and custom text remains intact after the priority requirement');
      assert.equal(finalPrompt.split('【最高优先级：中央主体完整，禁止误抠与缺失】').length - 1, 1);
      const repeated = buildImpactFrameGenerationPrompt({ ...slot, prompt: finalPrompt });
      assert.equal(repeated.split('【最高优先级：中央主体完整，禁止误抠与缺失】').length - 1, 1);
      const constraint = finalPrompt.split('当前生成模式的硬性限制（优先于上述提示词中冲突的描述）：')[1];
      assert.ok(constraint, 'Current mode rules explicitly take priority over saved or custom prompt text');
      assert.match(constraint, /只将参考画面中央的主要人物或对象/);
      assert.match(constraint, /该主体的完整轮廓/);
      assert.match(constraint, /延伸到画面中央区域之外/);
      assert.match(constraint, /不得改选旁边的人物或物体/);
      assert.match(constraint, /参考中可见的头脸、四肢、衣服、装备与其他部件必须完整/);
      assert.match(constraint, /不得误抠、遗漏或形成缺口/);
      assert.match(constraint, /保留参考原有的真实遮挡和画外截断/);
      assert.match(constraint, /不得凭空补出肢体/);
      assert.match(constraint, /如出现非原有缺失须先修补再输出/);
    }
    assert.match(background, /其余人物和物体不作为受保护主体，可作为场景背景处理/);
    assert.match(background, /不要沿用保护所有前景主体的要求/);
    assert.match(background, /所有改动仅限背景区域/);
    assert.match(background, /禁止给主体着色、重绘、加滤镜或叠加特效/);
    assert.match(subject, /完整保留中央主体之外的全部画面，包括背景及其余人物、物体/);
    assert.match(subject, /其他人物和物体不得作为修改对象/);
    assert.match(subject, /原主体身份、样貌、五官、发型轮廓、身体比例、姿态、位置及遮挡边界不变/);
    assert.match(subject, /禁止换脸或修改背景/);
    assert.deepEqual(slot, before, 'Preparing a generation never migrates saved prompts or discards images');
  }
  const mixed = resizeImpactFrameSlots([], 6, { generationMode: 'mixed', mixedModes: ['background', 'subject'] });
  assert.ok(mixed.every((slot) => buildImpactFrameGenerationPrompt(slot).includes('只将参考画面中央的主要人物或对象')));
  const slot = { id: 'one', prompt: '用户自定义：整个画面变红，替换人物样貌' };
  const reconstruct = buildImpactFrameGenerationPrompt({ ...slot, generationMode: 'reconstruct' });
  assert.match(reconstruct, /构图关系、相对位置、尺度/);
  assert.match(reconstruct, /原主体身份、样貌、五官、发型轮廓和身体比例必须保持不变/);
  assert.match(reconstruct, /^【最高优先级：中央主体完整，禁止误抠与缺失】/);
  assert.ok(reconstruct.includes(`\n\n${slot.prompt}\n\n`) && reconstruct.includes('优先于上述提示词中冲突的描述'));
});

test('legacy single-point projects keep all edits and empty multi-point data does not resurrect a deleted legacy frame', () => {
  const legacy = { sourceNodeId: 'video', sourceVideoUrl: '/one.mp4', frameUrl: '/frame.jpg', time: 2, width: 960, height: 540,
    slots: [{ id: 'impact-1', prompt: '已编辑的提示词', imageUrl: '/saved.png' }] };
  const points = getImpactFramePoints({ impactFrame: legacy });
  assert.deepEqual(points, [{ ...legacy, id: 'impact-legacy' }]);
  assert.equal(points[0].slots, legacy.slots);
  assert.deepEqual(getImpactFramePoints({ impactFrames: [], impactFrame: legacy }), []);
});

test('timeline point lookup selects an existing frame without mixing different points or resetting edits', () => {
  const base = { sourceNodeId: 'video', sourceVideoUrl: '/one.mp4', frameUrl: '/frame.jpg', width: 960, height: 540 };
  const first = { ...base, id: 'a', time: 0.5, slots: [{ id: 'impact-1', prompt: '红黑', imageUrl: '/a.png' }] };
  const second = { ...base, id: 'b', time: 1.5, slots: [{ id: 'impact-1', prompt: '蓝白', imageUrl: '/b.png' }] };
  const points = [first, second];
  assert.equal(findImpactFramePointAtTime(points, 0.501), first);
  assert.equal(findImpactFramePointAtTime(points, 1.5), second);
  assert.equal(findImpactFramePointAtTime(points, 1), undefined);
  assert.deepEqual(first.slots, [{ id: 'impact-1', prompt: '红黑', imageUrl: '/a.png' }]);
});

test('composition requires every slot to succeed, and source changes invalidate capture', () => {
  const frame = { sourceNodeId: 'video', sourceVideoUrl: '/one.mp4', frameUrl: '/frame.jpg', time: 2, width: 960, height: 540, slots: resizeImpactFrameSlots([], 5) };
  assert.equal(canComposeImpactFrame(frame), false);
  const completed = { ...frame, slots: frame.slots.map((slot) => ({ ...slot, imageUrl: `/image-${slot.id}.jpg` })) };
  assert.equal(canComposeImpactFrame(completed), true);
  assert.equal(canComposeImpactFrame({ ...completed, slots: completed.slots.map((slot, index) => index ? slot : { ...slot, error: '重新生成失败' }) }), false);
  assert.equal(canComposeImpactFrame({ ...completed, slots: [] }), false);
  assert.equal(isImpactFrameSourceCurrent(frame, 'video', '/one.mp4'), true);
  assert.equal(isImpactFrameSourceCurrent(frame, 'video', '/two.mp4'), false);
  assert.equal(isImpactFrameSourceCurrent(frame, 'replacement', '/one.mp4'), false);
  assert.equal(isImpactFrameSourceCurrent(frame, undefined, undefined), false);
});

test('image source identity stays separate from video captures and requires the same source node and image', () => {
  const frame = { sourceNodeId: 'source', sourceVideoUrl: '', sourceImageUrl: '/source.png', frameUrl: '/reference.png', time: 0, width: 960, height: 540, slots: resizeImpactFrameSlots([]) };
  assert.equal(isImpactFrameSourceCurrent(frame, 'source', '/source.png', 'image'), true);
  assert.equal(isImpactFrameSourceCurrent(frame, 'source', '/replaced.png', 'image'), false);
  assert.equal(isImpactFrameSourceCurrent(frame, 'other', '/source.png', 'image'), false);
  assert.equal(isImpactFrameSourceCurrent(frame, 'source', '/source.png'), false);
  assert.equal(isImpactFrameSourceCurrent(frame, 'source', '/source.png', 'video'), false);
  assert.equal(isImpactFrameSourceCurrent({ ...frame, frameUrl: '' }, 'source', '/source.png', 'image'), false);
  const video = { ...frame, sourceVideoUrl: '/source.mp4', sourceImageUrl: undefined };
  assert.equal(isImpactFrameSourceCurrent(video, 'source', '/source.mp4'), true);
  assert.equal(isImpactFrameSourceCurrent(video, 'source', '/source.mp4', 'image'), false);
});
