# Spine MCP

面向 Spine 4.3 的本地动画工具，让 AI 检查骨骼和约束、生成简单动作草稿、逐轨道调整关键帧、预览结果，再由动画师在 Spine 编辑器中继续修正。

## 安装与接入

需要 Node.js 22 或更高版本，以及已授权的 Spine 4.3 Professional。仅读取导出的 JSON 可以不安装 Spine；工程导入、导出与原生渲染需要本机 CLI。

```powershell
Set-Location F:\spine-mcp
npm ci
npm run build
```

在支持 stdio MCP 的客户端中添加以下配置，将路径替换为自己的安装位置：

```json
{
  "mcpServers": {
    "spine": {
      "command": "C:\\Program Files\\nodejs\\node.exe",
      "args": ["F:\\spine-mcp\\dist\\index.js"],
      "env": {
        "SPINE_BIN": "C:\\Program Files\\Spine\\Spine.com",
        "SPINE_VERSION": "4.3.26"
      }
    }
  }
}
```

启动后先让 AI 调用 `spine_doctor` 检查安装，再提供工程的绝对路径。MCP 进程通过标准输入输出通信；直接运行 `npm start` 后会等待客户端请求。

默认加载动画制作所需的 15 个工具，减少工具定义占用的上下文。需要完整的素材、绑定、媒体、QA 和 Unity 功能时，在客户端配置的 `env` 中添加 `"SPINE_MCP_TOOLSET": "all"`，并重启 MCP。全部模式提供 39 个工具。

若主要使用 AI 编写关键帧，可设置 `"SPINE_MCP_TOOLSET": "core"`，仅加载检查、预览、增改动画和备份所需的 11 个工具；此模式不加载生成器与动画派生的大参数定义。

单次文本结果超过 8000 字符时会返回摘要、完整报告文件和可分页读取的 MCP resource 链接。按需读取报告页即可；图片预览不受文本预算限制。

## 可以做什么

- **读取与检查**：骨骼、slot、约束、皮肤、动画轨道、循环、运行时表现和资源预算。
- **制作动作草稿**：呼吸、眨眼、摇摆、注视、跟随、走跑、口型，以及基于姿势的动作。
- **局部修改**：复制动画，新增、覆盖、替换或删除轨道关键帧，设置缓动曲线；支持骨骼、slot、约束、事件、绘制顺序和附件形变。
- **调整已有动作**：改变速度和幅度、镜像、重复、错开时间、清理关键帧、烘焙物理和跨骨架转移动画。
- **预览与交付**：Spine 原生渲染、联系表、运动轨迹、评审视频，以及运行时资源导出。
- **接入美术与游戏工程**：导入分层素材、建立初始绑定、更新图片，并检查或导入 Unity 资源。

## 推荐使用流程

1. 提供 `.spine` 工程路径，让 AI 检查骨架、约束和现有动画。
2. 描述动作目标、时长、幅度和循环要求，先生成新名字的草稿。
3. 用局部关键帧编辑调整转折和停顿，再渲染预览。
4. 在 Spine 中导入新动画，调整曲线、姿势和附件形变。
5. 检查循环与混合后，导出给游戏使用。

可以直接这样说：

> 读取 F:\spine-mcp\DFY\DFY.spine，检查骨架和 IK。基于 idle 做一个轻微低头发呆的草稿，使用新动画名，先 dry-run，再预览和写入。

动画写入工具默认 `apply: false`。加上 `apply: true` 后会建立备份，通过官方 CLI 仅导入目标动画，再回读核对。编辑器打开时默认写入 staging 副本；根据返回路径打开副本或执行 Import Project，才能在编辑器中看到结果。

## 文档

| 文档 | 用途 |
| --- | --- |
| [使用指南](docs/USAGE.md) | 检查工程、生成草稿、编辑关键帧、预览和人工接手 |
| [工具参考](docs/REFERENCE.md) | 39 个工具的用途、路径格式、参数与环境变量 |
| [参数参考](docs/TOOL_SCHEMAS.json) | MCP 工具的完整参数定义 |

## 上游来源

核心工程工作流来自 Berkan Işık 的 [berkanisk/spine-mcp](https://github.com/berkanisk/spine-mcp)。
