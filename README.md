# Poke’Catch 配队助手 · 简体中文改进版

**在原版基础上改进，不是从零开发。** 感谢 **GrumpyOwl** 的 [smuglilgoat/pokecatch-helper](https://github.com/smuglilgoat/pokecatch-helper)。本 Fork 保留原版来源，由 [yuezhihuohua](https://github.com/yuezhihuohua) 维护中文与手机适配、培养分析及使用体验改进。完整说明见 [UPSTREAM.md](UPSTREAM.md)。

当前中文版 **1.11.0**，原版基线 **1.6.4**。两边版本号独立。

## 安装

先在支持 Userscript 的浏览器环境中配置脚本管理器，再选择对应脚本：

| 使用场景 | 安装文件 |
| --- | --- |
| 手机触控 | [安装手机版](https://raw.githubusercontent.com/yuezhihuohua/pokecatch-helper-zh-cn/main/pokecatch-team-optimizer.mobile.zh-CN.user.js) |
| 电脑 | [安装电脑版](https://raw.githubusercontent.com/yuezhihuohua/pokecatch-helper-zh-cn/main/pokecatch-team-optimizer.zh-CN.user.js) |

若打开的是代码页面，请使用管理器的新建／导入脚本功能。已有旧版时替换原脚本，保存并刷新；同一页面只启用一份配队助手，避免与原版重复运行。

适用游戏：[Netlify](https://pokecatch-online.netlify.app/) / [Cloudflare Pages](https://pokecatch-online.pages.dev/)。手机能否运行由浏览器和脚本管理器决定；添加到主屏幕本身不保证脚本执行。当前没有启用脚本管理器自动更新，新版请从本仓库重新安装。

也可以从 [GitHub 发布页](https://github.com/yuezhihuohua/pokecatch-helper-zh-cn/releases/tag/v1.11.0) 下载对应的 ZIP。

## 主要功能

- **当前实力配队**：按仓库现有成员、实际等级和形态搜索，显示原队对照、模拟通过率与失败位置。
- **培养方向**：分别比较升级、一步进化、进化后升级；显示阶段上限、所需条件及收益，并排除不培养就能获得的相近收益。
- **分段方案**：按回复点切分，分别分析；显示相同队伍、保留原队理由及模板核对状态。
- **安排队伍**：可见的进度、取消与重试；明确说明途中通常在下一回复点才换成实际出战队伍。
- **传说配队**：加入首领状态和精英队伍规则，显示伤害、生存回合及模拟胜率，计算可取消。
- **团体战**：按伤害和预计生存时间选择己方与同伴。
- **游荡传说**：把路线上的游荡遭遇计入章节模拟。可在「进度 → 冒险监测」手动开启限频追捕。
- **中文与界面**：中文名称、搜索、问号说明、折叠面板；说明和换队弹窗使用游戏风格并随系统明暗变化。

## 推荐使用顺序

1. 进入“队伍／电脑” → “实战配队”。
2. 选择“整章挑战”或“下次回复后”，点“分析并推荐”。
3. 查看原队对照和建议；需要换队时再点“安排推荐队伍”。
4. 想了解培养投入，展开“培养方向”再分析。完成实际培养后重新推荐。
5. 需要分段自动安排时，先分析分段、保存并核对模板，再开启自动。

详细步骤、边界和验证范围见 [使用指南](USAGE.md)。

## 模型与适配范围

推荐是有限搜索下的模型结果，不保证最优或实战通关。培养建议逐项独立比较，收益不能相加；目标等级不是最低所需等级的证明。它不会自动升级、进化、使用道具或完成玩家交换。

本版核对的游戏资源为 `app.094b6c2ed2.js`（2026-11-23）。已用虚构存档验证桌面、模拟手机及游戏原生拖动填队流程。真实账号和手机真机仍待实测。游戏更新可能需要重新适配。

## 本仓库包含什么

仓库直接提供可安装、可阅读的独立脚本、使用说明与来源记录，不包含个人游戏存档、账号令牌或本地工作目录。原版文件保留用于记录来源，实际使用请选上方 `zh-CN` 文件。

- [改进记录](CHANGELOG.md)
- [原版来源与署名](UPSTREAM.md)
- [提交问题](https://github.com/yuezhihuohua/pokecatch-helper-zh-cn/issues)

本仓库没有为上游代码声明新的统一许可证；第三方游戏数据、素材和商标权利归原权利人。
