# 花漾贴贴 Petal Pop

怀旧贴纸创作游戏：整个游戏是一张俯视的书桌——存钱罐是商店、星星罐是抽奖、书立插满收藏的本子和贴纸条。从贴纸条上撕下贴纸，在海报、换装底板、房间里自由创作，桌面本身也哪里都能贴。

- 平台：PC（打包 exe，先在小圈子分享；其他平台适配后议）
- 类型：休闲 / 收集 / 贴贴创作（自由拼贴、换装、房间造景起步）
- 模式：**免费**单机情怀作品，本地存档，不做任何商业化
- 状态：第一个可玩版本已跑通（运行时内核 + 默认素材包）

## 文档索引

| 文档 | 内容 |
|---|---|
| [01 游戏设计](docs/01-game-design.md) | 核心玩法、系统拆解、情怀细节清单 |
| [02 美术规划](docs/02-art.md) | 画风定义、素材清单、AI 出图流水线 |
| [03 技术方案](docs/03-tech.md) | 技术选型、架构、存档、Steam 集成 |
| [04 开发路线图](docs/04-roadmap.md) | 里程碑划分、每步的验收标准 |
| [05 分发计划](docs/05-release.md) | 打包分发、更新方式、素材授权记录 |
| [06 制作人锐评](docs/06-producer-review.md) | 外部评审原始意见 + 结论落地记录 |
| [07 主题库](docs/07-theme-backlog.md) | 100+ 后续主题弹药，按贴法模板归档 |
| [08 素材包格式](docs/08-pack-format.md) | 包目录约定、manifest 字段、id 规则、版本锁、安装体检（共建者必读） |

## 一句话定位

> 「打开这个游戏，就是坐回放学后的书桌前——摇一罐星星换条贴纸，撕下来，想贴哪就贴哪。」

所有设计决策都用这句话校验：让体验更像那个下午的，做；不像的，砍。

## 试玩

在线玩：<https://aezir.github.io/petal-pop/demo/>（首次打开会从 GitHub 下载默认素材包，之后走本地缓存）。

本地玩：双击 `start-demo.bat`（或在项目根目录执行 `python -m http.server 8765`），浏览器打开 `http://127.0.0.1:8765/demo/`。
不能直接双击 html 打开：素材要经 fetch 加载，file:// 下浏览器不允许。

```
demo/            运行时内核（纯静态网页，不含任何素材）
  js/db.js       IndexedDB：kv 状态 / blobs 按 sha256 存文件 / packs 已装清单
  js/packs.js    素材包：来源解析、清单校验、原子安装、卸载、垃圾回收
  js/state.js    状态 + normalize 升格 + apply(action)
  js/render.js   从状态画画面
  js/app.js      交互与工具条
packs/default/   默认素材包（第一个包，和别人做的包地位相同）
tools/make-manifest.py   给包目录生成 manifest.json
assets/          原始素材工作区（出图、切图在这里，不被游戏直接读取）
```

## 许可

- **代码**（本仓库）：[PolyForm Noncommercial 1.0.0](LICENSE)。可以自由使用、修改、分发，**严禁任何商业用途**。使用时请保留声明：`Required Notice: Copyright Aezir (https://github.com/Aezir/petal-pop)`。
- **素材**（[petal-pop-assets](https://github.com/Aezir/petal-pop-assets) 及默认包）：CC BY-NC-SA 4.0。署名、**禁止商用**、衍生素材必须以相同许可发布。
- 共建的第三方素材包建议同样采用 CC BY-NC-SA 4.0，并在 manifest 的 `license` 字段写明。
