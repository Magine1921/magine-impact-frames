# 原画布接入源码

本目录保存 MAGINE Canvas 一键冲击帧的 React 节点、时间轨道、图片编辑控件和进度动效，便于阅读、移植和在自有画布中接入。这里不是一个可以直接 `npm run dev` 启动的完整画布应用，也不参与根目录核心包的编译。

- `src/components/nodes/ImpactFrameNode.tsx`：完整节点工作流，包括默认/高级模式、多点截帧、六路生图队列、合成、历史记录和完成通知。
- `src/components/nodes/ImpactFrameTimeline.tsx`：缩略图时间轨道与截取点。
- `src/components/nodes/ImpactFrameImageActions.tsx`：本机/画布图片替换与放大预览。
- `src/components/canvas/`：红蓝流动生成效果和淡白色节点进度边框。
- `src/lib/impact-frame-media.ts`：原始素材持久化、解码和浏览器可播放地址处理参考。
- `src/lib/impact-frame-generation.ts`：公开的生图服务适配入口。需要宿主实现 `getModels` 和 `generate`，不含商业模型账号、支付或私有服务代码。
- `impact-frame.css`：仅抽取所需动效和光标样式；已移除原应用背景图片引用。

源码包含用户在节点内操作的默认/高级模式完整流程，以及核心路径转发文件和生图服务适配器。具体宿主依赖和服务协议见 [接入说明](../../docs/integration.md)。只想离线合成时，直接使用根目录的 CLI，无需这些画布依赖。

本目录采用仓库根目录的 Apache-2.0 许可证；该许可不覆盖未包含的 MAGINE Canvas 应用、账号体系或商标。

生图适配器与手动工作流的离线回归测试（Node.js 22.18+，先构建根目录核心包）：

```sh
npm run build
node --test integrations/magine-canvas/*.test.mjs
```
