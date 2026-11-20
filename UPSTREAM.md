# 原版来源与改进说明

本项目基于 **GrumpyOwl** 的 [smuglilgoat/pokecatch-helper](https://github.com/smuglilgoat/pokecatch-helper) 改进。原项目作者信息保留，中文版由 [yuezhihuohua](https://github.com/yuezhihuohua) 维护。

- 原版基线：**1.6.4**。
- 基线提交：[f65c0cc7dcd1b1f77dd1a3be3ea55f448912ea26](https://github.com/smuglilgoat/pokecatch-helper/commit/f65c0cc7dcd1b1f77dd1a3be3ea55f448912ea26)。
- 原版脚本 SHA-256：`94a7b36ad73870c75f8109f3c6c3d91c00a25d75a1779d283b6f49027bb44668`。
- 核对日期：2026-11-20。中文版 1.9.0 是本分支自己的版本号，不表示原版也发布了 1.9.0。
- 原版脚本 `pokecatch-team-optimizer.user.js` 保留在 Fork 中；安装本分支时请选择带 `zh-CN` 的文件。
- 原版说明另存为 `UPSTREAM_README.md`，内容描述的是原版，当前行为以本仓库 README 与使用指南为准。

## 保留的原版基础

原版提供章节路线模拟、队伍候选搜索、冒险团灭监测、分段模板、传说与团体战辅助等基础能力。本分支不是从零独立创作的配队引擎。

## 本分支主要改进

1. 简体中文名称、说明、错误提示和手机触控适配。
2. 按当前真实等级、形态和状态推荐，与原安排做同场景对照；未来培养另行评估。
3. 升级、一步进化、进化加升级的培养方向，检查阶段上限和条件，并比较不培养能否取得接近收益。
4. 分段分析、模板写入、自动提前安排分开操作；显示保留原因、原队对照及核对状态。
5. 换队过程可见、可取消，明确区分安排队伍与实际出战队伍；成员、路线、前台状态等变化时检查停止条件。
6. 团体战己方与同伴选择分开处理，修复入口重建、上下文识别等问题。
7. 游戏风格说明及进度弹窗，随设备系统明暗切换。
8. 游戏资源延迟加载重试、解析兼容、中文搜索等修复。

## 第三方数据与许可状态

原版仓库在核对时没有声明统一的软件许可证。本分支保留出处和作者信息，不为上游代码追加 MIT 等授权。公开可见不等于取得对第三方代码、图像或商标的额外许可；参见 [GitHub 关于仓库许可的说明](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/licensing-a-repository)。

运行时读取的游戏资料和图像由 [Poke’Catch](https://pokecatch-online.netlify.app/) 提供；名称及资料核对涉及 [PokéAPI](https://pokeapi.co/) 和 [Pokémon Database](https://pokemondb.net/)。相关内容的权利归各自权利人。本仓库不是游戏官方版本。
