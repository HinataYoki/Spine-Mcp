# 第三方许可声明

## Spine 与运行时

Spine 编辑器需自行安装和授权。本项目调用本机官方 CLI；依赖的 spine-core、spine-webgl 和可选 spine-unity 适用以下许可。

~~~text
Spine Runtimes License Agreement
Last updated April 5, 2025. Replaces all prior versions.

Copyright (c) 2013-2025, Esoteric Software LLC

Integration of the Spine Runtimes into software or otherwise creating
derivative works of the Spine Runtimes is permitted under the terms and
conditions of Section 2 of the Spine Editor License Agreement:
https://esotericsoftware.com/spine-editor-license

Otherwise, it is permitted to integrate the Spine Runtimes into software
or otherwise create derivative works of the Spine Runtimes (collectively,
"Products"), provided that each user of the Products must obtain their own
Spine Editor license and redistribution of the Products in any form must
include this license and copyright notice.

THE SPINE RUNTIMES ARE PROVIDED BY ESOTERIC SOFTWARE LLC "AS IS" AND ANY
EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL ESOTERIC SOFTWARE LLC BE LIABLE FOR ANY
DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES
(INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES,
BUSINESS INTERRUPTION, OR LOSS OF USE, DATA, OR PROFITS) HOWEVER CAUSED AND
ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
(INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF
THE SPINE RUNTIMES, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
~~~

## 工程、素材与依赖

角色工程、PSD 和贴图适用项目方的素材授权。官方示例 raptor、owl、mix-and-match、spineboy 的许可正文见 docs/media/examples/LICENSE-*.txt。其他依赖的许可证见各软件包中的 LICENSE。

## MIT 协议与上游来源

核心代码来自 Berkan Işık 的 [berkanisk/spine-mcp](https://github.com/berkanisk/spine-mcp)，MIT 正文见 [LICENSE](LICENSE)；源码镜像来自 [Glama](https://glama.ai/mcp/servers/berkanisk/spine-mcp/tree)，来源提交 6622571eb1a90115d5b2bd3389bd7d40fb1998a4。

src/spine/keyframes.ts 的关键帧合并、复制工作流和相对／绝对曲线换算改写自 Umut Faruk 的 [UmutFarukDilli/spine-mcp](https://github.com/UmutFarukDilli/spine-mcp) 中 project.py，来源提交 c5689892a990d252a7d51ae3bb1427374fb093f8。其 MIT 许可完整保留如下：

~~~text
MIT License

Copyright (c) 2026 Umut Faruk

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
~~~

素材及其他工具署名：

- Bolt 和 logo 示例随核心代码采用 MIT。
- 视频音乐：Sascha Ende，Happy Beats / Business Moves, Vol. 12，[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)，[作者网站](https://ende.app)。
- UI 音效：Kenney，CC0，[来源](https://kenney.nl)。
- 视频制作工具：[HyperFrames](https://hyperframes.heygen.com)。
- 可选外部程序：[Rhubarb Lip Sync](https://github.com/DanielSWolf/rhubarb-lip-sync)（MIT）、[See-through](https://github.com/shitagaki-lab/see-through)（Apache-2.0）。
- 官方 runtime：[spine-runtimes](https://github.com/EsotericSoftware/spine-runtimes)。
