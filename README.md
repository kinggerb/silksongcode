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

`web/` 是把游戏放进 iPad 浏览器的移植层. 做法的来源是同一个作者的空洞骑士网页版
(`kinggerb/hollowknightgame`): **分块下载 → 直接写进设备上的 OPFS → 只把一整份文件交给
Unity**, 全程不在内存里拼装, 所以下载过程中峰值内存只有几 MB 而不是几 GB; 第二次打开
不下任何数据. 另外还有画质档位 (100 % → 25 % 渲染分辨率 + 帧率上限 + 自动降档), 崩溃
阶梯 (上次被系统杀掉就下次自动降一档), 硬性内存上限, 音频守卫, 以及把过场视频换成几百
字节的黑屏占位 (构建时替换, 顺带瘦身几百 MB).

```shell
cd web
npm install                      # 只有 jsdom, 给页面测试用
npm test                         # 6 个测试套件, 75 个用例

node tools/serve.mjs 8080        # 静态服务器 (支持 Range + wasm MIME), iPad 直接访问
node tools/make-fixture-build.mjs   # 造一份假构建, 用 demo.html 验证加载器
```

页面 (`web/play.html`) 需要一份 **Unity WebGL 构建** (`Build/*.loader.js|framework.js|wasm|data`)
才能真正开始游戏; 这个仓库里没有这份构建, 怎么产出, 怎么处理, 怎么校验见
`web/BUILD.md`, 实机使用与画质档位见 `web/IPAD.md`.
