# 工具参考

以下表格介绍 39 个工具的用途和写入范围；完整参数以 MCP 的 `tools/list` 为准，也可以查阅 [参数参考](TOOL_SCHEMAS.json)。标为“只读”的工具仍可能写入缓存或生成预览，不修改输入工程。

默认 `SPINE_MCP_TOOLSET=animation` 提供 15 个动画工具：[默认参数参考](TOOL_SCHEMAS_ANIMATION.json)。下表的其他工具需要设置 `SPINE_MCP_TOOLSET=all` 并重启 MCP。

## 工程与诊断

| 工具 | 用途 | 写入范围 |
| --- | --- | --- |
| spine_doctor | CLI、版本、授权、runtime、媒体程序检查 | 只读 |
| spine_status | 文件状态、staging、备份、近期步骤 | 只读 |
| spine_editor_status | 编辑器状态及 staging 动画导入检查 | 只读 |
| spine_project_info | 一个或多个工程的版本、骨架、动画列表 | 只读 |
| spine_export_json | 将工程导出为工作缓存中的 JSON | 缓存 |
| spine_inspect | 结构、骨骼、slot、皮肤、约束或精确时间线 | 只读 |

## 检查与测量

| 工具 | 用途 | 写入范围 |
| --- | --- | --- |
| spine_validate | 静态引用、关键帧、曲线、runtime、循环和面部检查 | 只读 |
| spine_measure | 逐骨骼位移、速度、角速度、停顿与循环交界 | 只读 |
| spine_timing | 关键姿势、间隔、缓动与停顿 | 只读 |
| spine_compare_animations | 两动画的测量或渲染对比 | 只读／预览 |
| spine_mix_check | 动画混合、跳变和事件检查 | 只读 |
| spine_budget | 顶点、三角形、约束、draw call 等预算 | 只读 |
| spine_rig_qa | 命名、无用资源、权重、关节接缝和网格贴合 | 只读 |
| spine_skins | 单皮肤与皮肤组合检查，可选预览 | 只读／预览 |
| spine_audit | 文件夹内工程的批量检查 | 只读 |

## 动作与工程写入

| 工具 | 用途 | 写入范围 |
| --- | --- | --- |
| spine_edit_animation | 复制动画、逐轨道增改删关键帧、归一化缓动 | 工程／staging |
| spine_add_animation | 校验并添加一份 4.3 动画 JSON | 工程／staging |
| spine_derive_animation | 对源动画执行 ops，生成变体 | 工程／staging |
| spine_generate_animation | 呼吸、眨眼、注视、走跑等生成器 | 工程／staging |
| spine_transfer_animation | 骨架间按名称映射及可选尺寸重定向 | 目标工程／staging |
| spine_import_layers | PSD 或 PNG 布局放置为新工程 | 新工程和素材 |
| spine_auto_rig | 从分层素材建立起始骨架和网格 | 新工程和素材 |
| spine_rig_edit | 骨骼、约束、皮肤等结构编辑 | 新工程 |
| spine_update_images | 用新 PSD 更新图像并比对 | 图片文件 |
| spine_list_backups | 列出指定工程的备份 | 只读 |
| spine_restore_backup | 校验后恢复备份 | 指定工程 |
| spine_snapshot | 保存工程快照用于后续比较 | 快照 |
| spine_reimport_diff | 与快照或另一工程比较结构和运动 | 只读 |

## 渲染、视频和运行时

| 工具 | 用途 | 写入范围 |
| --- | --- | --- |
| spine_render_frames | Spine 原生 PNG 序列和联系表 | 渲染缓存 |
| spine_showcase | 多动画并排 WebP／GIF／MP4 | output 文件 |
| spine_review_video | 标注帧号、速度和音频的评审视频 | output 文件 |
| spine_motion_visual | 洋葱皮、轨迹、数值曲线 | 预览 |
| spine_reference_timing | 分析参考视频节奏并比较动画 | 分析缓存 |
| spine_video_inspect | 逐帧分析剪辑、停顿、闪烁和音频 | 分析缓存 |
| spine_video_frames | 精确抽帧、差分或叠影 | 预览 |
| spine_export | JSON／skel／atlas 导出及打包参数试算 | outputDir |
| spine_unity_check | Unity runtime、渲染及可选性能检查 | 验证缓存 |
| spine_unity_import | 导入游戏工程、设置资源和 prefab | Unity 工程 |
| spine_web_check | Web runtime 与 Spine 原生渲染比较 | 验证缓存 |

<a id="derive-operations"></a>
<a id="derive-operations"></a>
## 动画派生操作

| op | 主要参数 | 作用 |
| --- | --- | --- |
| scaleValues | factor、bones、kinds | 调整动作幅度 |
| retime | factor | 等比改变时长，2 表示半速 |
| keepBones / dropBones | bones | 保留／过滤骨骼时间线 |
| offsetBones | bones、seconds、wrap | 骨骼时间错位 |
| offsetSlots | slots、seconds、wrap | 颜色、附件和 deform 时间错位 |
| loopFix | bones、slots | 修正首尾姿势 |
| ease | easing、bones、kinds、slots | 设定缓动曲线 |
| swapBones | pairs | 交换左右等成对时间线 |
| mirror | pairs | 按骨架进行世界空间镜像 |
| repeat | times | 合并多次重复为一个动画 |
| bakePhysics | bones、fps、loop、tolerance 等 | 将物理模拟烘焙为关键帧 |
| blocking | keyPosesOnly、minTimelines | 改为关键姿势与阶梯曲线 |
| spline | smoothness、all、loop 等 | 从 blocking 建立平滑曲线 |
| events | add、footsteps、replace | 添加已定义事件／脚步事件 |
| setupKeys | from | 为未控制的属性补 setup keys |
| clean | thin、bones | 整帧、数值和冗余键清理 |

## 参数与写入规则

- 路径使用绝对路径；多个骨架时填写 `skeleton`。
- 骨骼旋转使用 `value`；位移和缩放使用 `x`、`y`；时间为秒。
- 4.3 的贝塞尔为绝对坐标，多个通道依次各写四个值。
- `apply` 默认关闭；`replace` 必须显式允许才能替换同名动画。
- `editor: "auto"` 在编辑器打开或状态未知时使用 staging；`staging` 总是写旁路副本；`inPlace` 强制写指定文件，需确保编辑器不会用旧内存副本覆盖它。
- `allowUpgrade` 允许把旧主次版本工程写成固定 CLI 版本；更换版本先做副本和兼容检查。
- 写入返回 `verification`：核对 `animationMatches`、`otherAnimationsUnchanged`、`structureUnchanged` 及 `differences`。
- `spine_restore_backup` 为恢复操作；默认 dry-run。`force` 可绕过编辑器打开检查，不作为日常流程。

## 环境变量

| 变量 | 含义／默认 |
| --- | --- |
| SPINE_BIN | Windows 默认 C:\Program Files\Spine\Spine.com |
| SPINE_MCP_TOOLSET | core（11 个基础工具）、animation（默认，15 个动画工具）、all（39 个完整工具） |
| SPINE_VERSION | 固定 CLI 版本，默认 4.3.26 |
| SPINE_MCP_WORKDIR | 缓存、备份、操作记录；Windows 默认 %LOCALAPPDATA%\spine-mcp |
| SPINE_CLI_TIMEOUT_MS | 单次 CLI 超时，默认 180000 毫秒 |
| SPINE_MCP_PROFILE | 团队 JSON：工具默认参数、导出和 Unity 规则 |
| CHROME_BIN | Chrome 可执行文件；用于 Web 和部分可视化 |
| RHUBARB_BIN | 音素口型程序路径 |
| UNITY_BIN / UNITY_HUB_EDITORS | Unity 可执行文件／Hub 编辑器目录 |
| SPINE_UNITY_RUNTIMES | 本地 spine-runtimes 检出路径 |
| SPINE_EXAMPLES | `npm run fixtures` 的示例目录 |

<a id="timeline-paths"></a>
## 关键帧轨道路径

`spine_edit_animation.path` 从动画对象开始，不包含动画名：

| 路径 | 用途 |
| --- | --- |
| ["bones", "骨骼名", "rotate"] | 旋转，字段 value |
| ["bones", "骨骼名", "translate"] | 平移，字段 x、y |
| ["bones", "骨骼名", "scale"] | 缩放，字段 x、y，默认值 1 |
| ["slots", "slot名", "attachment"] | 附件切换，字段 name |
| ["slots", "slot名", "rgba"] | 颜色，字段 color，RRGGBBAA |
| ["ik", "约束名"] | IK mix、softness 等 |
| ["transform", "约束名"] | 变换约束混合值 |
| ["path", "约束名", "position"] | 路径约束位置 |
| ["physics", "约束名", "mix"] | 物理约束混合值 |
| ["slider", "约束名", "属性名"] | 以实际导出的 4.3 轨道为准 |
| ["events"] | 已定义的事件，字段 name |
| ["drawOrder"] | 绘制顺序，字段 offsets |
| ["attachments", "皮肤名", "slot名", "附件名", "deform"] | 附件形变，字段 offset、vertices 等 |

骨骼还可使用 translatex/y、scalex/y、shear、shearx/y；slot 颜色可使用 rgb、alpha、rgba2、rgb2。先用 `spine_inspect` 确认实际轨道结构。局部编辑引用已存在的骨骼、slot、约束和事件定义。drawOrderFolder 不属于此工具的路径范围，可用完整动画 JSON 编辑。

`set.keys` 使用 Spine 4.3 原生字段。`easing` 为归一化曲线，只在支持数值通道的轨道上自动转换；`key.curve` 使用绝对时间和值。`delete.times` 省略即删除整条轨道。示例见 [使用指南](USAGE.md#keyframe-editing)。

## 可选程序

按工具需要安装 ImageMagick、ffmpeg、ffprobe、img2webp、Rhubarb 或 Unity。Spine 自带 ffmpeg 的编码器和输入协议可能不完整；视频工具需要完整媒体工具链。只做骨骼关键帧编辑无需安装这些程序。

## MIT 协议与上游来源

代码采用 [MIT 许可证](../LICENSE)。核心能力来自 Berkan Işık 的 [berkanisk/spine-mcp](https://github.com/berkanisk/spine-mcp)，镜像见 [Glama](https://glama.ai/mcp/servers/berkanisk/spine-mcp/tree)；局部编辑和曲线处理改写自 Umut Faruk 的 [UmutFarukDilli/spine-mcp](https://github.com/UmutFarukDilli/spine-mcp)。完整声明见 [第三方声明](../THIRD_PARTY_NOTICES.md)。
