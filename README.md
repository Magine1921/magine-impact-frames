# MAGINE Impact Frames · 一键冲击帧

**【一键冲击帧】多点截帧·一键合成** — 从 MAGINE Canvas 提取的冲击帧源码。

把关键画面的一组高反差图片，在选定时间点快速闪播，再回到原视频。支持视频多点合成，也支持以图片为输入制作独立冲击帧短片。

![原创机甲侠客与巨魔的九格冲击帧示意](docs/images/01-impact-cover.png)

> 这里提供可独立运行的 TypeScript 核心库、FFmpeg 合成 CLI，以及原画布功能的接入源码。CLI 使用已经准备好的图片；自动生图需要接入自己的图生图服务。`integrations/magine-canvas/` 依赖宿主画布，不能当作完整 MAGINE Canvas 客户端直接启动。

## 功能范围

| 功能 | 独立核心 / CLI | 原画布接入源码 |
| --- | --- | --- |
| 视频多个时间点、图片输入 | 支持 | 支持 |
| 每组 1–50 张冲击图 | 支持 | 支持 |
| 多色图、仅换背景、仅变主体、参考重构、混合 | 提示词与状态生成 | 模型选择、单图编辑 |
| 慢 / 中 / 快，直切 / 叠化 / 闪黑 / 闪白 | 支持 | 可视化控制 |
| 胶片时间轨、截点选择、换图与放大 | — | React 源码 |
| 默认 6 张、最多 6 张并发生成 | 宿主实现图像生成 | 原节点工作流 |
| 输出连线、历史素材、完成通知 | — | 宿主接入 |

“仅换背景”保护中央完整主体；“仅变主体”只修改中央主体并保留背景与其他对象。完整性要求写入最终生图提示词，不含额外大模型审核；实际效果依赖图像模型，不能保证自动修复每一种缺损。

## 流程与界面

![从输入素材、选择截点到生成冲击图与合成输出的四步流程](docs/images/05-workflow.png)

视频先选择时间点，图片直接作为参考；生成多种风格后快速闪播，合成成品。

<p align="center">
  <img src="docs/images/03-advanced-controls.png" width="420" alt="高级模式界面：五种生成方式、图片数量、三挡速度和转场选择" />
</p>

上图为原画布高级模式的界面示例，展示可移植的交互设计。对应 React 源码在 `integrations/magine-canvas/`，完整操作截图见[使用教学](docs/tutorial.md)。

## 快速开始

需要 **Node.js 22.18+** 和 npm。首次安装会下载依赖及 FFmpeg，可使用自己安装的 FFmpeg，见下文。

```bash
git clone https://github.com/Magine1921/magine-impact-frames.git
cd magine-impact-frames
npm ci
npm run build
npm test
npm run demo
```

演示完全在本机生成几何素材、短视频和六色图片，再实际合成视频与图片输入示例。没有 API 密钥要求，也不会调用付费模型。具体输出路径由命令打印。

## 合成自己的素材

新建 `job.json`。所有文件路径相对于这份 JSON；输入必须是本地文件。

```json
{
  "videoPath": "./input.mp4",
  "outputPath": "./impact-output.mp4",
  "points": [
    {
      "timestamp": 2,
      "imagePaths": ["./frames/01.png", "./frames/02.png", "./frames/03.png", "./frames/04.png", "./frames/05.png", "./frames/06.png"],
      "speed": "fast",
      "transition": "cut"
    }
  ]
}
```

```bash
node dist/cli.js compose job.json
```

默认拒绝覆盖已有输出。确定需要重做时，追加 `--overwrite`。输入文件不能同时作为输出。

图片输入：把 `videoPath` 改为 `sourceImagePath`，只保留一个 `timestamp: 0` 的图片组。多点视频：向 `points` 添加其他时间点及对应图片。

| 参数 | 可选值 | 含义 |
| --- | --- | --- |
| `speed` | `fast` / `medium` / `slow` | 每张保持 1 / 2 / 3 帧；CLI 默认 `fast` |
| `transition` | `cut` / `dissolve` / `flash-black` / `flash-white` | 直切 / 叠化 / 闪黑 / 闪白；默认 `cut` |
| `timestamp` | 秒数 | 视频范围内的时间点；图片输入固定 0 |
| `imagePaths` | 1–50 个路径 | 同一时间点按顺序闪播的图片 |

转场会增加相邻图片之间的过渡帧。视频接近尾部时，整组效果会前移以完整放入视频；时间点之间的效果区间不能重叠。短视频的直切模式可以缩短到每张一帧，仍放不下则报错。原视频总时长和音轨会保留，输出采用 H.264 / MP4；变量帧率素材会规范为固定帧率，因此不承诺逐字节保留编码数据。

## 作为库使用

构建后，浏览器可用的提示词与配置逻辑从 `dist/index.js` 导入，Node 合成逻辑从 `dist/impact-frame-video.server.js` 导入。作为依赖安装时，也可分别使用包名 `magine-impact-frames` 和子路径 `magine-impact-frames/server`。核心入口不加载 FFmpeg 或 sharp。

```ts
import { resizeImpactFrameSlots, buildImpactFrameGenerationPrompt } from './dist/index.js';

const slots = resizeImpactFrameSlots([], 6);
const prompts = slots.map(buildImpactFrameGenerationPrompt);
// 把每条提示词与同一张参考图交给自己的图生图服务。
// 保存返回图片后，将文件路径传入合成器。
```

```ts
import { composeImpactFrameVideo } from './dist/impact-frame-video.server.js';

await composeImpactFrameVideo({
  videoPath: '/absolute/input.mp4',
  outputPath: '/absolute/output.mp4',
  points: [{ timestamp: 2, imagePaths: ['/absolute/01.png', '/absolute/02.png'], speed: 'fast', transition: 'cut' }],
});
```

库的底层合成函数会写入指定输出路径；面向用户的 CLI 额外执行文件验证与覆盖保护。服务端接入时，应在自己的可信工作目录中分配输入、输出路径。

## 接入画布

- [接入说明](docs/integration.md)：画布状态、图生图适配器、缓存、进度、历史与通知边界。
- [带图使用教学](docs/tutorial.md)：MAGINE Canvas 原界面的操作教学；其中界面入口由宿主应用提供。
- `integrations/magine-canvas/`：原 React 节点、时间轨、换图面板和样式等参考源码。

图生图服务拒绝参考图片时应报告失败，不能悄悄改成纯文字生成。已有图片与自定义提示词应保留，方便只重试失败的冲击图。

## FFmpeg

解析顺序为 `FFMPEG_PATH` → 安装的 `ffmpeg-static` → 系统 PATH。例如 PowerShell：

```powershell
$env:FFMPEG_PATH = 'C:\ffmpeg\bin\ffmpeg.exe'
npm run demo
```

若依赖下载受网络限制，可使用本机 FFmpeg。安装方式和实际依赖许可见 [第三方说明](THIRD_PARTY_NOTICES.md)。本仓库和源码 ZIP 不包含 FFmpeg、libvips 或 node_modules 二进制。

已有 FFmpeg 时，可在安装前同时设置 `FFMPEG_BIN`，让 `ffmpeg-static` 跳过二进制下载；仍正常安装 sharp 的平台依赖：

```powershell
$env:FFMPEG_PATH = 'C:\ffmpeg\bin\ffmpeg.exe'
$env:FFMPEG_BIN = $env:FFMPEG_PATH
npm ci
```

## 开源范围与许可

本次独立发布的源码与文档采用 [Apache-2.0](LICENSE)。这是对本仓库提取内容的新授权，不代表 MAGINE Canvas 整个商业客户端开源。商标、第三方依赖及其二进制不因本仓库许可证而改变许可。

演示插画为本次教程原创生成素材，测试几何素材由脚本生成；未收录用户上传的影视视频、账户信息或 API 密钥。来源与改动记录见 [NOTICE](NOTICE) 和 [第三方说明](THIRD_PARTY_NOTICES.md)。
