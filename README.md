# Silksong-RL

丝之歌强化学习训练.

游戏子实例在 game 当中, 而不是 steam 目录.

反编译代码在 disassebmly 当中.

scoop 有安装 dnspy, 可以使用这个来进行反编译.

子实例需要提权启动, 不然外部有些文件无法写入.

## 目录

| 路径 | 内容 |
| --- | --- |
| `mods/rl-env` | 强化学习环境插件: 观测采集, 动作注入, 回合重置, 与训练进程通信 |
| `mods/boss-rush` | Boss 复战插件, 提供 42 份 Boss 存档与清单, `rl-env` 复用这套资源 |
| `mods/object-outlines` | 排查用的对象描边插件 |
| `trainer` | Python 训练侧: 环境封装, 奖励计算, PPO 训练与评估 |
| `docs` | 丝之歌 mod 制作方法汇总, 训练设计说明 |
| `disassembly` | 反编译产物, 只用于阅读 |
| `web` | 网页版移植: iPad Safari 分块加载器, 构建流水线, 试玩页面 (见 `web/IPAD.md`) |

## 快速上手

```shell
# 编译并安装 RL 环境插件 (含 Boss 存档资源)
just build-rl-env

# 训练侧自检, 不需要开游戏
just selfcheck

# 游戏内: 启动游戏进入任意存档, 插件会等训练侧连接

# 开始训练
just train --timesteps 200000 --run-name moss-mother-a
```

详细说明见 `mods/rl-env/README.md`, `trainer/README.md` 与 `docs/rl-training.md`.

## 网页版 (iPad Safari)

`web/` 是把游戏放进 iPad 浏览器的移植层。默认社区构建现在按需下载 ZIP 分片到 OPFS，
不再等完整的 1.25 GB 归档下载完才启动 Unity；已下载分片和已提取资源会复用。
加载器还修复了缓存被探测器清空、并发断点续传和 worker 退出超时，并将 Wasm 流式编译与资源准备并行。
完整实现、回退开关和测试结果见 [web/LOADING-OPTIMIZATIONS.md](web/LOADING-OPTIMIZATIONS.md)。
三分钟内进入可操作游戏仍需目标 iPad 实测，不把小型测试结果当作完整游戏性能承诺。

```shell
cd web
npm install                      # jsdom, 给页面测试用
npm test                         # 全部测试套件

node tools/serve.mjs 8080        # 静态服务器 (支持 Range + wasm MIME), iPad 直接访问
node tools/make-fixture-build.mjs   # 造一份假构建, 用 demo.html 验证通用加载器
```

页面默认使用 `web/community-build.json` 中固定版本的社区 WebGL 构建。游戏文件不会被复制进本仓库：
Unity 入口文件从构建源 CDN 加载，完整 Addressables 归档为约 1.17 GiB；首次启动只下载所需资源覆盖的分片，
之后随游戏进程继续缓存。建议 Wi-Fi、普通 Safari 标签页和至少约 2 GiB 可用存储（包括提取缓存）；
具体来源、版本和限制见 `web/COMMUNITY-BUILD.md`。如果有本地或自托管的标准 Unity WebGL 构建，
`web/play.html` 会优先使用它；准备与校验方法见 `web/BUILD.md`，实机使用与画质档位见 `web/IPAD.md`.

首次下载途中可能被 GitHub 限流（未登录的 raw 下载按小时计数，而分片有 75 个），页面会
自动等待并继续，已下载的分片不会丢；详见 `web/COMMUNITY-BUILD.md`。

GitHub Pages 的仓库根地址 `https://kinggerb.github.io/silksongcode/` 由根目录的
`index.html` 转到 `web/play.html`（保留查询参数和 hash），`.nojekyll` 则让 Pages 原样提供文件。
若关闭社区构建回退（`?community=0`）且没有标准构建，页面会明确显示 **Game build not found** 并禁用 Start；
`web/demo.html` 仍可在不下载游戏的情况下测试通用加载器。
