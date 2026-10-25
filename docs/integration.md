# 将一键冲击帧接入自己的画布

根目录的 TypeScript 核心与 FFmpeg 合成器可以独立运行。`integrations/magine-canvas` 包含用户在节点内操作的默认/高级模式界面和工作流参考源码，需要下列宿主适配才能运行；它不包含完整的 MAGINE Canvas 商业应用。

## 前端依赖与目录

原界面使用 React 19、React DOM、React Flow 11（包名 `reactflow`）、Lucide React 和 Tailwind CSS。将接入目录的 `src` 合并到宿主，并使 `@/` 指向宿主 `src/`。安装/本地链接 `magine-impact-frames`，两个 `src/lib/impact-frame.ts`、`src/lib/impact-frame-video.ts` 转发文件会使用本包的公开核心。

引入 React Flow 的样式与 `impact-frame.css`，将提取的 TSX 文件加入 Tailwind 内容扫描。组件包含 `nodrag`、`nopan`、任意值尺寸和透明度等 utility classes，不能只加载动效 CSS。原应用的全局主题、连接倾斜动效和窗口壳层样式没有整体复制，宿主可以提供自己的主题。

在 React Flow 的 `nodeTypes` 中注册 `ImpactFrameNode`，或在已有 Skill 节点渲染器中按 `data.skillId === 'canvas-technique-impact-frames'` 分派。该节点左侧接收图片或视频，右侧输出成品视频，不能当成普通提示词 Skill 处理。

## 必须实现的宿主接口

以下导入故意保留原路径，明确显示与宿主的边界。不要为了让 TypeScript 通过而把未实现的方法替换成静默成功。

| 路径（省略 `src/`） | 职责 |
| --- | --- |
| `components/canvas/CanvasStore` | 提供 `useCanvasStore` 与 `CanvasNodeData`；支持订阅、`getState()`、节点列表、`updateNodeData`、`addNodeWithData`、`onConnect`。新增成品节点必须同步可读；进度更新允许 `{ recordUndo: false }`。 |
| `components/canvas/useCanvasDerivedData` | `getIncomingMaterialRefs`、`useIncomingMaterialRefs` 读取节点连入素材，`useMaterialRefs` 枚举可替换图片。必须返回真实视频/原图地址，不能把缩略图误作视频输入。 |
| `components/seedance/SeedanceStore` | 原节点只订阅 `config` 以刷新模型列表。接入时替换为自己的模型配置订阅 hook；无需复制原账号 Store。 |
| `components/canvas/MediaZoomPan` | `MediaPreviewOverlay`、`ZoomableImagePreview` 提供有关闭操作的弹窗和可缩放大图。 |
| `lib/material-mentions` | `MaterialRef` 与 `getMaterialReferenceKind`；素材至少提供 `nodeId`、`fileUrl`、`thumbnailUrl`、`fileName`、`slug` 和真实图片/视频类型。 |
| `lib/material-import-from-file` | `captureVideoFrameDataUrl` 读取指定视频时间的完整帧；`getMaterialKindFromFile`、`resolveMaterialMediaAspect` 校验替换文件并解码尺寸。 |
| `lib/material-disk-playable-url` | `resolveMaterialPlayableUrl`、`materialDiskPlayableUrl`、`isProjectCacheMaterialUrl`、`isLocalFilesystemMediaPath`，把存储标识转换为浏览器可读取地址。 |
| `lib/canvas-material-idb` | `getMaterialBlob`、`isMaterialIdbRef`、`materialRefToNodeId`，恢复 IndexedDB 原素材；`requireOriginal: true` 不能退回缩略图。 |
| `lib/maginecanvas-media-binary` | `sniffBinaryMedia` 根据文件头识别真实图片/视频 MIME 与扩展名；不要仅信任上传的 Content-Type。 |
| `lib/persist-generated-media` | `persistImageToMaterialCache`、`persistVideoToMaterialCache`，将参考帧、生成图片、远程/临时视频保存成稳定地址。 |
| `lib/generation-notification-store` | `useGenerationNotificationStore.getState().notify({ nodeId, outcome, summary })`；成功通知指向新产出节点。 |
| `lib/region-reparent` | `getAbsoluteTopLeft`，计算分组内节点的画布绝对位置，用于右侧创建成品。 |
| `lib/node-error-message` | `unwrapNodeError`，把宿主 IPC/网络错误整理成用户可读文本。 |

`CanvasNodeData` 的功能字段包括 `impactMode`、`impactSourceNodeId`、`impactImageModel`、`impactFrames`、`impactActivePointId`，以及兼容旧项目的 `impactFrame`；使用本包导出的 `ImpactFramePoint`/`ImpactFrameState` 类型。成品历史保存在 `generatedVideos`，任务状态保存在 `generationProgress`。

## 生图服务适配

这里提供的 `impact-frame-generation.ts` 是新的公开适配入口，原应用的厂商密钥、账户、支付和请求实现未包含在仓库中。初始化时调用 `configureImpactFrameImageProvider({ getModels, generate })`：

- `getModels()` 返回已启用且支持参考图片的模型列表；`value` 使用 `providerId::model`，厂商和模型分别具有显示名称。
- `generate(params)` 接收 `prompt`、`referenceImage`、`width`、`height`、`model`、`isCurrent`、`onProgress`，一次只生成一张图片，返回可读取的图片地址。图片队列由节点调度，最多六张同时进行。
- 参考图是确认后的完整单帧。模型拒绝参考图时报告失败并保留输入与连线，不允许偷偷改成纯文生图。
- 在提交请求前和轮询中检查 `isCurrent`，把服务进度通过 `onProgress(0..100)` 回传。节点只有在图片读取、保存完成后才标记成功；远端任务已经提交时，不保证能取消服务端计费。
- 主体完整性要求已加入 `buildImpactFrameGenerationPrompt(slot)`，没有额外的大模型审核调用。宿主也不应自动增加未请求的审核、重试或付费步骤。
- 密钥由自己的后端持有，浏览器只调用自己的 API。此适配器没有预置任何付费服务地址。

## 本地素材与合成服务

`impact-frame-media.ts` 保留了原素材缓存流程，依赖宿主的 `POST /api/project-cache/material-upload`：multipart 字段 `nodeId`、`file`，成功返回 `{ "ok": true }`。如果宿主使用不同存储方案，应替换为自己的实现。不要把未持久化的 `blob:` URL 发给 Node.js 合成进程。

节点请求 `POST /api/impact-frame/compose`，两种操作共享接口。下面是视频的校验请求：

```json
{
  "nodeId": "impact-1",
  "videoUrl": "/media/source.mp4",
  "validateOnly": true,
  "points": [{ "timestamp": 2, "imageCount": 6, "speed": "fast", "transition": "cut" }]
}
```

真正合成时去掉 `validateOnly`，用 `imageUrls: ["/media/frame-1.png", "..."]` 替代各点的 `imageCount`。图片输入使用 `sourceImageUrl` 替代 `videoUrl`，且只允许一个 `timestamp: 0` 的点。成功响应至少是 `{ "videoUrl": "/media/result.mp4", "width": 1280, "height": 720 }`；错误用非 2xx 状态与 `{ "error": "可读说明" }` 返回。

宿主服务把素材 URL 解析为受控本地文件，调用 `magine-impact-frames/server` 的 `validateImpactFrameVideoPoints` / `validateImpactFrameImagePoints` 或 `composeImpactFrameVideo` / `composeImpactFrameImage`，保存成品后返回可播放地址。不要把任意网络 URL 或用户路径直接当成本地可信文件；桌面应用应限制本机请求，Web 服务需要自己的身份验证与素材访问控制。原 Next.js 路由依赖专有缓存系统，因此没有原样发布。

默认模式为新截取点创建六张图片，合成使用快速、直切；已有高级编辑会保留。高级模式保留每个截取点的数量、慢中快速度与直切/叠化/闪黑/闪白转场。实际每图时长依赖视频帧率；合成器保持视频总时长和原音频。时间段重叠、视频过短或图片缺失应在生图前校验并明确失败。

## 保留的工作流约束

- 素材身份由类型、节点 ID、文件地址共同确定；断开或更换素材后隐藏旧参考帧，并阻止旧异步结果写回。
- 合成前后都比较截取点快照；用户删除节点、替换素材或切换项目后不创建过期成品。
- 成功时创建右侧视频素材节点、连线，写入 Skill 的 `generatedVideos`，再发一次完成提醒。宿主的历史面板需读取此字段，通知定位需使用新输出节点 ID。
- 节点边框进度位于与内容相同的视觉容器。若宿主有连接倾斜动画，应仅倾斜 `.mc-impact-frame-visual` 并把边框绘制在这一层，连接端口保持固定；不要分别变换外框和内容。
- 提取代码不含完整画布的通用能力发现、工具权限、历史素材列表和视角动画。宿主需要接入这些已有能力，或自行实现对应界面。
