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

`web/` 是把游戏放进 iPad 浏览器的移植层. 准备版构建会把数据分块流式写进设备 OPFS，再交给
Unity；默认社区构建则把 Addressables ZIP 分片缓存到 OPFS，按需提取资源。两条路径都避免在内存里
拼装多 GiB 文件，并会复用已缓存的数据。另外还有画质档位 (100 % → 25 % 渲染分辨率 + 帧率上限 + 自动降档), 崩溃
阶梯 (上次被系统杀掉就下次自动降一档), 硬性内存上限, 音频守卫, 以及把过场视频换成几百
字节的黑屏占位 (构建时替换, 顺带瘦身几百 MB).

```shell
cd web
npm install                      # jsdom, 给页面测试用
npm test                         # 全部测试套件

node tools/serve.mjs 8080        # 静态服务器 (支持 Range + wasm MIME), iPad 直接访问
node tools/make-fixture-build.mjs   # 造一份假构建, 用 demo.html 验证通用加载器
```

页面默认使用 `web/community-build.json` 中固定版本的社区 WebGL 构建。游戏文件不会被复制进本仓库：
Unity 入口文件从构建源 CDN 加载，约 1.94 GiB 的 Addressables 分片会在首次启动时流式写入 iPad 的 OPFS，
之后由 `zip.js` 按需读取资源。首次启动需要 Wi-Fi、普通 Safari 浏览标签页和约 2 GiB 可用存储；
具体来源、版本和限制见 `web/COMMUNITY-BUILD.md`。如果有本地或自托管的标准 Unity WebGL 构建，
`web/play.html` 会优先使用它；准备与校验方法见 `web/BUILD.md`，实机使用与画质档位见 `web/IPAD.md`.

GitHub Pages 的仓库根地址 `https://kinggerb.github.io/silksongcode/` 由根目录的
`index.html` 转到 `web/play.html`（保留查询参数和 hash），`.nojekyll` 则让 Pages 原样提供文件。
若关闭社区构建回退（`?community=0`）且没有标准构建，页面会明确显示 **Game build not found** 并禁用 Start；
`web/demo.html` 仍可在不下载游戏的情况下测试通用加载器。
