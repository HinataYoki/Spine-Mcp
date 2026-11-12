# 使用指南

安装和客户端配置见 [首页](../README.md)。仓库中的 `DFY/` 是可直接用于验证的 Spine 4.3 工程副本。文件路径使用绝对路径，时间单位为秒，旋转单位为度，位移使用骨架单位。中文骨骼名可以直接填写。

## 检查工程

先调用 `spine_doctor`，确认 CLI、版本和授权。使用 `spine_project_info` 读取工程中的骨架和动画列表，再用 `spine_inspect` 查看结构：

```json
{"input":"F:\\spine-mcp\\DFY\\DFY.spine","view":"summary"}
```

要看具体时间线，传 `view: "animation"`、`animation`、`owner` 和 `kind`。开始修改前先用 `spine_validate` 查看引用、关键帧、曲线与循环问题；恢复制作时用 `spine_status` 确认工程是否有外部修改。

原始列表和动画轨道使用 `offset`、`limit` 分页，返回 `nextOffset`。动画关键帧使用 `keyOffset`、`keyLimit`，每条轨道返回 `totalKeys` 和 `nextKeyOffset`。先按 `owner` 和 `kind` 缩小范围，再读取所需的键，避免整份工程进入对话。

当文本结果仍超过 8000 字符时，会返回 `truncated: true`、摘要、`file` 和 `report`。支持 MCP resources 的客户端可读取 `spine-report://…/0`，按返回的 `next` 逐页继续；其他客户端可以按需读取 `file`。报告缓存最多保留 40 份，过期后重新调用工具。

默认只有 15 个常用动画工具。需要下文的转移、素材、视频、物理 QA、运行时导出或 Unity 等扩展功能时，设置 `SPINE_MCP_TOOLSET=all` 并重启 MCP。完整参数参考对应全部工具模式。

## 生成简单动作

写入工具默认 dry-run，只检查计划。检查返回的摘要和问题后，将同一请求改为 `apply: true`。优先使用新名字，替换同名动画需要额外传 `replace: true`。

调用 `spine_generate_animation` 制作呼吸草稿：

```json
{
  "project":"F:\\spine-mcp\\DFY\\DFY.spine",
  "skeleton":"DFY",
  "type":"breathe",
  "name":"ai_breathe",
  "breathe":{"torso":["胸"],"followers":["头"],"period":2,"amount":0.03,"restStart":true},
  "apply":false
}
```

骨骼名称取决于角色的绑定。部分生成器会在参数缺失时返回骨骼建议；特殊绑定应明确填写控制骨。腿部受 IK 控制时优先修改 IK 目标，避免被约束骨上的关键帧失效。

<a id="generate-options"></a>
## 生成器类型

| type | 参数对象 | 用途 |
| --- | --- | --- |
| breathe | breathe | 胸部起伏和跟随骨 |
| sway / settle | sway / settle | 链条摇摆、衰减回弹 |
| blink / gaze / lookAt | blink / gaze / lookAt | 眨眼、扫视、头眼跟随 |
| followThrough | followThrough | 为源动画添加次级运动 |
| turn / squash | turn / squash | 转头、网格挤压拉伸 |
| blocking | blocking | 将姿势组织成动作关键点 |
| walk | walk | 基于髋、腿、手臂和 IK 的走跑循环 |
| lipSync | lipSync | 口型或下颌运动 |

复杂动作可以先确定关键姿势，再编辑各轨道。例如坐下动作需要结合角色的髋、腿部 IK、躯干与手臂控制，不是所有角色都能套用同一组数值。完整参数见 [参数参考](TOOL_SCHEMAS.json)。

<a id="keyframe-editing"></a>
## 复制与局部关键帧编辑

`spine_edit_animation` 从 `source` 复制出 `name`，按顺序执行 `edits`，最后统一校验和导入。`edits: []` 直接复制整个动画。默认使用新名字保留源动画；同名输出需 `replace: true`。

下面以 `idle` 为基础，替换头部旋转轨道，其余轨道保留：

```json
{
  "project":"F:\\spine-mcp\\DFY\\DFY.spine",
  "skeleton":"DFY",
  "source":"idle",
  "name":"ai_head_daze",
  "edits":[
    {
      "op":"set",
      "path":["bones","头","rotate"],
      "mode":"replace",
      "easing":"ease-in-out",
      "keys":[{"time":0,"value":0},{"time":0.5,"value":-5},{"time":1,"value":0}]
    }
  ],
  "apply":false
}
```

`set` 的模式：

| mode | 行为 |
| --- | --- |
| upsert（默认） | 相同时间用新关键帧覆盖，其他时间保留 |
| append | 只添加新时间，遇到冲突报错 |
| replace | 整条轨道替换为给定关键帧 |

覆盖时替换的是完整关键帧，修改平移键时应同时提供需要保留的 `x`、`y`。时间按小数点后六位匹配。同一时间的不同名称事件可以共存；同时间同名事件按一个键处理。

删除指定时间的关键帧，将下面对象放入 `edits`：

```json
{"op":"delete","path":["bones","头","rotate"],"times":[0.5]}
```

省略 `times` 表示删除整条轨道；找不到指定时间会报错。删除后空轨道会被清理。路径以数组表达，各段是原始名称，即使骨骼或附件名包含 `/` 也不需要拆分。详见 [轨道路径表](REFERENCE.md#timeline-paths)。

`easing` 支持 `linear`、`stepped`、`ease`、`ease-in`、`ease-out`、`ease-in-out`、`smooth`，也支持 `cubic-bezier(...)` 或归一化数组 `[cx1,cy1,cx2,cy2]`。横坐标在 0～1 范围内，纵坐标可超出此范围形成回弹；多通道可以各传四个值。曲线应用于本次给出的键到其下一键之间，末键无插值目标时不写贝塞尔。

数值骨骼、slot 颜色、IK、变换约束及常用 path/physics 数值轨道可自动转换曲线。附件 deform 等其他轨道使用原生 Spine JSON 关键帧；原生 `key.curve` 为绝对时间和值坐标，不能与同一次编辑的 `easing` 混用。插入或删除键会按新间隔换算已有支持轨道的曲线，保持归一化缓动形状；它会改变该段运动，需要重新预览。

<a id="derive-operations"></a>
## 调整已有动画

`spine_derive_animation` 用于改速度、幅度、镜像、重复和清理等整段操作：

```json
{
  "project":"F:\\spine-mcp\\DFY\\DFY.spine",
  "source":"idle",
  "name":"idle_slow",
  "ops":[{"op":"retime","factor":1.2}],
  "apply":false
}
```

`factor: 1.2` 表示时长变成 1.2 倍。操作按顺序执行，完整列表见 [工具参考](REFERENCE.md#derive-operations)。已有外部动作可以用 `spine_transfer_animation` 映射到目标骨架；自己编写的完整动画 JSON 使用 `spine_add_animation`。

## 预览并在 Spine 中接手

调用 `spine_render_frames`：

```json
{"project":"F:\\spine-mcp\\DFY\\DFY.spine","skeleton":"DFY","animation":"ai_head_daze","maxFrames":12,"scale":50}
```

实际调用时使用写入结果返回的工程路径。`scale` 为百分比；`maxFrames` 限制联系表采样数，工具会返回渲染目录和联系表。观察动作开始、转折、稳定姿势和循环交界；需要数值时使用 `spine_measure` 或 `spine_timing`。

编辑器打开时，默认 `editor: "auto"` 把动画写到 staging 副本。此时：

1. 保存编辑器中的修改。
2. 按返回的 `staged.importSteps` 通过 Import Project 导入目标动画，或直接打开 `staged.stagedProject` 查看。
3. 保存后调用 `spine_editor_status` 核对导入状态。

编辑器不会自动刷新磁盘上的外部修改。如果只看到原来的动画，检查实际打开的文件名与工具返回路径。要明确写入旁路副本可用 `editor: "staging"`；`editor: "inPlace"` 用于已关闭的工程，避免编辑器用旧内容覆盖磁盘结果。

## 备份和恢复

实际写入前会建立备份，通过官方 CLI 仅导入目标动画，并回读核对目标动画、其他动画和骨架结构；不匹配时回滚。检查返回的 `verification` 和 `differences`。

`spine_list_backups` 查看工程备份，`spine_restore_backup` 按 `backupId` 恢复。恢复同样默认 dry-run，并在实际恢复前保存当前文件。备份存放在 `SPINE_MCP_WORKDIR`，更换该目录会改变可见备份列表。

<a id="faces"></a>
## 面部与附件形变

眨眼可能由骨骼、slot 附件切换或附件 deform 实现。先检查现有面部时间线，再选生成器或复制修改现有键。面部审查使用 `spine_validate.face`，按角色实际眼皮、眼睛、隐藏附件和嘴型填写参数。

<a id="into-your-unity-project"></a>
## 导出和 Unity

`spine_export` 将 JSON、skel 和 atlas 输出到 `outputDir`。`spine_unity_import` 将资源写入指定 Unity 工程，`spine_unity_check` 与 `spine_web_check` 检查运行时表现。先确认目标 runtime 与 Spine 4.3 数据格式匹配。

## 常见问题

| 现象 | 处理 |
| --- | --- |
| CLI 找不到或版本不符 | 检查 SPINE_BIN、SPINE_VERSION，再运行 spine_doctor |
| 中文名称无法自动识别 | 用 spine_inspect 查询后明确填写骨骼和约束名 |
| 有关键帧但骨骼不动 | 检查 IK、变换和物理约束，键控实际控制器 |
| 旧版本工程无法写入 | 用副本确认兼容后明确传 allowUpgrade: true |
| 媒体预览缺少编码器 | 按工具要求安装完整 ffmpeg、ffprobe、ImageMagick 等；Spine 自带裁剪版未必满足 |
| 修改源码后客户端仍无新工具 | 重新构建并重启客户端的 MCP 进程 |

## MIT 协议与上游来源

代码采用 [MIT 许可证](../LICENSE)。核心能力来自 Berkan Işık 的 [berkanisk/spine-mcp](https://github.com/berkanisk/spine-mcp)，镜像见 [Glama](https://glama.ai/mcp/servers/berkanisk/spine-mcp/tree)；局部关键帧编辑和曲线处理改写自 Umut Faruk 的 [UmutFarukDilli/spine-mcp](https://github.com/UmutFarukDilli/spine-mcp)。完整第三方许可见 [第三方声明](../THIRD_PARTY_NOTICES.md)。
