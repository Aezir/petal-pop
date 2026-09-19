# 08 素材包格式（Pack Format v1）

游戏本体只是一台"播放器"，它不自带任何一张图。所有内容都来自素材包。
这份文档是包和播放器之间的合同，做包的人照它做，改播放器的人照它改。

## 1. 目录约定

一个包就是一个目录（或一个 GitHub 仓库的根目录）：

```
my-pack/
  manifest.json        必需
  stickers/            贴纸，png / jpg / webp / gif
  boards/              底板（本子、人偶板、房间…）
  backgrounds/         桌面背景
  bgm/                 音乐，mp3 / ogg / m4a
  skin.json            界面皮肤（可选，见第 11 节）
  textures/            皮肤用的纹理图
```

目录名只是习惯，播放器真正看的是 manifest 里每个条目的 `file` 路径。

## 2. manifest.json

```json
{
  "formatVersion": 1,
  "id": "petalpop-default",
  "name": { "zh": "花漾默认包", "en": "Petal Pop Default" },
  "version": "1.0.0",
  "author": "hydomo",
  "license": "CC-BY-NC-4.0",
  "description": "一句话介绍",
  "entries": [
    { "id": "strawberry", "type": "sticker", "file": "stickers/strawberry.png",
      "w": 64, "h": 60, "sha256": "…64 位十六进制…", "bytes": 4210,
      "name": "草莓", "tags": ["食物", "春天"] },
    { "id": "notebook-09", "type": "board", "file": "boards/notebook-09.png", "w": 401, "h": 244, "sha256": "…" },
    { "id": "desk-day",    "type": "background", "file": "backgrounds/desk-day.png", "w": 1672, "h": 941, "sha256": "…" },
    { "id": "woods",       "type": "bgm", "file": "bgm/woods.mp3", "sha256": "…" },
    { "id": "theme",       "type": "skin", "file": "skin.json" },
    { "id": "paper-tex",   "type": "skin-asset", "file": "textures/paper.png", "w": 64, "h": 64 }
  ]
}
```

### 包级字段

| 字段 | 必需 | 说明 |
|---|---|---|
| `formatVersion` | 是 | 整数。播放器认识的版本比它小就拒绝安装并提示升级 |
| `id` | 是 | 包的身份，全球唯一，**定下后永不改**。规则：小写字母/数字/`-`/`_`，字母数字开头，最长 64 |
| `name` | 否 | 字符串，或 `{"zh":…, "en":…}` 多语言对象 |
| `version` | 是 | 字符串，建议语义化版本 `主.次.补` |
| `author` `license` `description` | 否 | 纯文本展示。共建包请一定写 license，建议 `CC-BY-NC-SA-4.0`（禁止商用、衍生同许可） |
| `sheet` | 否 | 贴纸纸原图尺寸 `{"w":1536,"h":1024}`。配合条目的 `sheet` 位置，播放器照原图排版摆出这个包的贴纸纸 |
| `scale` | 否 | 手动指定这个包的缩放比例（0～4）。不写就按 6.5 节的规则自动算 |

### 条目字段

| 字段 | 必需 | 说明 |
|---|---|---|
| `id` | 是 | 条目身份，包内唯一，规则同包 id，**定下后永不改**（改名、换图都不改 id） |
| `type` | 是 | `sticker` / `board` / `background` / `bgm` / `skin`（界面皮肤配置）/ `skin-asset`（皮肤纹理、预览图） |
| `file` | 是 | 相对包根的路径，不能以 `/` 开头，不能含 `..` |
| `w` `h` | 图片建议 | 像素尺寸。播放器安装时会用真实解码尺寸覆盖 |
| `sha256` | 建议 | 文件内容哈希。写了播放器就校验，对不上拒绝安装 |
| `bytes` | 否 | 文件大小，仅展示用 |
| `name` `tags` `anchor` `deprecated` | 否 | 预留：显示名、标签、锚点（换装玩法用）、弃用标记 |
| `sheet` | 否 | 仅贴纸：在原图贴纸纸上的左上角位置 `{"x":12,"y":34}`（原图像素）。用 `tools/locate-on-sheet.py` 自动生成 |

播放器只读它认识的字段，**不认识的字段一律忽略、不报错**。所以包可以先于播放器加字段。

**不认识的条目类型**（比播放器更新的包格式）也不报错：那个条目跳过不装，记进安装记录，设置页的包列表会写明"跳过了哪些"；玩家升级游戏后点「更新」就能补装。只有整个包一个条目都不认识时才拒绝安装。
（给改播放器的人：新增 `type` 必须把 `packs.js` 的 `INSTALLER` 加一，否则清单哈希没变的老包不会重装、补不上。）

## 3. 引用规则：`包id:条目id`

存档、装机清单、文档里引用任何内容都用 `包id:条目id`，例如 `petalpop-default:strawberry`。
永远不引用文件路径，永远不引用哈希。

- 两个包里都有 `heart.png` 不冲突，因为包 id 不同。
- 做包的人把 `a.png` 改名成 `heart.png`，只要 `id` 没变，所有人的存档照常。
- 存档里引用的包没装或被禁用，那个位置显示"缺失"占位，不崩；装回来自动复原。

## 4. 两层身份：id 管"意思"，哈希管"字节"

| 层 | 用什么 | 负责 |
|---|---|---|
| 引用层 | `包id:条目id` | 存档、锚点、标签、人和人之间的沟通 |
| 存储层 | sha256 | 去重、增量更新、完整性校验、垃圾回收 |

manifest 就是两层之间的桥：每个版本里 id → 哈希的一张对照表。
同一张图重新导出，哈希变了，id 不变；同一份字节被两个条目引用（发饰蝴蝶结 / 鞋饰蝴蝶结），哈希一样，id 两个。

## 5. 版本与更新

- GitHub 来源不走 GitHub API（匿名每小时只有 60 次，很容易用光），全部经 jsDelivr：
  - 写了 `@版本`：锁到这个标签 / 分支 / commit。
  - 没写版本：向 jsDelivr 查这个仓库**最新的标签**并锁住；一个标签都没有才用默认分支。
  - 所以做包请**打标签发布**（`git tag v1.1.0`）。默认分支的内容 jsDelivr 会缓存数小时到数天，改了不会马上生效。
- 已安装记录保存 `包id + version + 锁定的标签 + manifest 的 sha256`。同一个标签被重传成不同内容也会被发现。
- "更新"按钮：重新解析来源，锁定标签或 manifest 哈希变了才重新安装。
- 更新是原子的：新版本全部文件下载、体检、校验通过后，才一次性切换记录；中途失败保留旧版本。

## 6. 安装时的体检（不只信文件后缀）

| 检查 | 规则 |
|---|---|
| 类型 | 只认六种 `type`（不认识的跳过，见第 2 节）；图片只收 png/jpg/webp/gif，**不收 svg**；音频只收 mp3/ogg/m4a；皮肤配置只收 .json |
| MIME | 图片、音频的 Content-Type 必须是 `image/*` / `audio/*`；皮肤 JSON 不查 MIME（本地静态服务器常给 text/plain） |
| 可解码 | 图片必须能被浏览器解码；音频检查文件头（ID3 / MPEG 帧 / OggS / ftyp）；`skin.json` 必须是对象且 `skinVersion` 不比播放器认识的新 |
| 哈希 | manifest 写了 `sha256` 就必须对上 |
| 上限 | 单文件 32MB，单包 300MB，条目 2000 个；`skin-asset` 最长边 2048 像素 |

包里**永远不会执行脚本**，这是共建的安全底线。

### GitHub 来源的额外限制

jsDelivr 单文件最大 20MB，超过的文件播放器会自动改从 GitHub raw 拉（上限 100MB，但没有 CDN 加速，国内很慢）。音乐尽量压到 128kbps 左右（一首 4 分钟约 4MB）。

## 6.5 素材质量（视觉效果第一）

玩家不能缩放贴纸，但不同包的原图分辨率不一样，播放器用一条统一规则把它们换算到桌面上（游戏行业叫 PPU，每单位多少像素）：

- **一个包 = 桌上的一张贴纸纸**，包里所有贴纸都在这一张上，不分页。写了 `sheet` 排版就照原图摆，没写就自动挤在一张纸上。
- 这张纸按"标准贴纸纸"大小摆上桌：**最大 768 × 512 舞台像素**（和打开的本子差不多宽），由此算出这个包的缩放比例 `scale`（原图本来就更小的不放大，按 1）。例：1536 × 1024 的原图 → 0.5。
- 贴纸在纸上、桌上、本子上都按同一个 `scale` 显示，所以**纸上看到多大，贴出去就多大**。包想要别的大小可以自己写 `scale`。
- 比例 ≥ 1 时用最近邻采样（像素风不糊），小于 1 时用平滑采样（像素画硬缩会出锯齿）。本子固定按 760 舞台像素宽显示。

| 项目 | 要求 |
|---|---|
| 贴纸尺寸 | 同一个包里的贴纸保持彼此真实的大小关系（直接从一张贴纸纸原图上裁最好）；原图短边 64 到 256 像素 |
| 底板尺寸 | 长边 400 像素上下（播放器按 760 舞台像素宽显示，约 2 倍放大） |
| 桌面背景 | 1672 × 941，或同比例更大 |
| 格式 | 透明底 PNG 优先；照片类可用 WebP |
| 描边 | 贴纸四周保留 1 到 2 像素的白色描边，贴在任何底色上都清楚（默认包就是这个做法） |
| 留白 | 裁到内容边缘，四周不留透明边距，否则透明边也能被抓起来 |

## 7. 弃用与兼容

- 想删一个条目：先在条目上加 `"deprecated": true` 发一版，播放器不再在贴纸纸上展示它，但已贴的仍然显示；下一大版本再真正删除。
- 想换一个条目的 id：不允许。新建一个新 id 的条目，旧的走弃用流程。
- 想改 `formatVersion`：只在旧播放器无法安全忽略新字段时才升。升了就是宣布老播放器装不了。

## 8. 用工具生成 manifest

```bash
python tools/make-manifest.py packs/my-pack --id my-pack --name "我的包" --version 1.0.0
```

工具按目录约定扫描文件，算尺寸和 sha256。**已有条目的 id、name、tags 等人工字段原样保留**，只刷新哈希和尺寸；新文件按文件名生成 id；删掉的文件从清单移除并提示。
第一次生成后请检查 id 是否满意，之后就别再动它们了。

贴纸是从一张贴纸纸原图上裁下来的，可以再跑一步把原图排版写进清单（每张贴纸在原图里的位置；有任何一张对不上就不写）：

```bash
python tools/locate-on-sheet.py packs/my-pack 原图.png
```

## 9. 安装来源写法

| 写法 | 含义 |
|---|---|
| `local:packs/default` | 跟游戏放在一起的目录（相对项目根） |
| `用户名/仓库名` | GitHub 仓库最新标签；没有标签则默认分支 |
| `用户名/仓库名@v1.2.0` | 指定标签、分支或 commit |

现成的例子：`Aezir/petal-pop-assets`（默认包）。

## 10. 存档与素材包的关系

存档里存的是 `包id:条目id` 和坐标，不存图。换电脑只要装同样的包，存档就能完整复原。
装机清单（装了哪些包、启用哪些、当前底板和背景）和作品一起存在游戏状态里，几 KB 的 JSON，后续可以同步到自己的 GitHub 仓库。

## 11. 界面皮肤（`skin` / `skin-asset`）

皮肤改的是**系统界面**——工具栏、贴纸纸卡片、设置弹窗、提示条、加载页——不是桌面和本子（那两个是 `background` / `board`）。
一个包可以带任意个皮肤；纯皮肤包（只有 `skin` 和 `skin-asset` 条目）和贴纸包附带皮肤都行。玩家在工具栏「换皮肤」循环切换，或在设置页「皮肤」里选；同一时间只有一套生效，"默认主题"本身是一个选项。

### skin.json

```json
{
  "skinVersion": 1,
  "name": "海盐蓝",
  "preview": "preview",
  "colors": {
    "ink": "#2f3f5f", "paper": "#eef3ff", "pink": "#8fb8ff", "pinkDeep": "#4b7bd6",
    "shadow": "rgba(30,50,90,.35)", "pageBg": "#16202e", "stageBg": "#7f97b8", "overlay": "rgba(10,20,40,.55)",
    "glow": "#ffffff", "onAccent": "#ffffff",
    "btnHover": "#dde8ff", "btnDangerHover": "#ffd6d6", "inputFocus": "#e8f0ff",
    "tabOnBg": "#ffffff", "packRowBg": "#ffffff",
    "barTrack": "#ffffff", "barFill": "#8fb8ff", "barFillDeep": "#4b7bd6",
    "sheetGrad1": "#dbe8ff", "sheetGrad2": "#c4d8f7", "sheetGrad3": "#adc6ee",
    "sheetDotColor": "rgba(255,255,255,.7)", "sheetDotSmColor": "rgba(255,255,255,.4)", "sheetDashColor": "rgba(255,255,255,.9)"
  },
  "textures": { "sheetPaper": "paper-tex", "box": "paper-tex", "button": null, "modal": null, "toast": null, "loading": null },
  "sheet": { "dotPattern": false, "dashedBorder": true, "borderRadius": 10 },
  "font": null
}
```

| 字段 | 说明 |
|---|---|
| `skinVersion` | 必需，整数。比播放器认识的新就拒绝安装 |
| `name` | 显示名，最长 60 字 |
| `preview` | 同包一个 `skin-asset` 的条目 id，设置页当缩略图（建议 120×90）。不写就用 ink / paper / pink 三色拼一个色块 |
| `colors.*` | 每个键对应界面上的一种取色（`ink` 描边和文字、`paper` 盒子底、`pink` 强调、`pinkDeep` 深强调、`shadow` 硬阴影、`pageBg` 页面底、`stageBg` 桌面兜底色、`overlay` 弹窗遮罩、`glow` 盒子内圈亮边、`onAccent` 强调色上的文字、`btnHover` 等悬停/聚焦色、`sheet*` 贴纸纸渐变三色和波点/虚线色）。不认识的键忽略 |
| `textures.*` | 纹理槽位，值是同包 `skin-asset` 的条目 id。`sheetPaper` 贴纸纸底；`box` 所有盒子（弹窗、提示条、加载卡）；`button` 按钮；`modal` / `toast` / `loading` 单独覆盖对应的盒子，不写就用 `box` |
| `sheet` | `dotPattern` / `dashedBorder`：布尔，关掉贴纸纸的波点 / 虚线框；`borderRadius`：0～64 的整数（像素） |
| `font` | 字体名列表字符串（如 `"Zpix", "Microsoft YaHei", sans-serif`）。**只用玩家机器上已有的字体，不会加载远程字体** |

所有字段可选；`null` 或不写 = 保持默认；不认识的字段忽略。

### 值的写法（白名单，不是黑名单）

皮肤是第三方内容，播放器只接受能一眼看穿的字面量：

- 颜色：`#rgb` `#rgba` `#rrggbb` `#rrggbbaa`，或 `rgb()` `rgba()` `hsl()` `hsla()` 且括号里只有数字、`.`、`%`、空格、逗号、`/`。
  `var(--x)`、`url(...)`、`calc()`、颜色名（`red`）都不收——不是因为它们危险与否，而是只有字面量才能保证它们**只会被当成颜色**。
- 不合法的值单独丢弃并在控制台说明（设置页会标"N 处配置被忽略"），不影响其余字段、不影响安装。
- 皮肤名等文字按纯文本显示，不解析 HTML。

### 纹理的约定

- 纹理**只替换底层**：贴纸纸的波点、虚线框仍由 `sheet.*` 控制；盒子的描边、阴影、内圈亮边仍由 `colors.*` 控制。
- 按原尺寸**平铺**，1 图片像素 = 1 舞台逻辑像素，最近邻采样（像素风不糊）。所以纹理做成能无缝拼接的小块（64～256 见方）最合适；整幅插画当面板底不在 v1 的目标里。
- 最长边不超过 2048 像素。

### 切换与兜底

- 切换即时生效、不刷新页面；从皮肤 A 切到只写了部分字段的皮肤 B，B 没写的字段回到默认，不会残留 A 的值。
- 皮肤所在的包被禁用或卸载：界面回到默认主题，但玩家的选择保留着，包装回来自动恢复（和底板、桌面一样）。
- 上次的颜色会记在本机（localStorage），下次打开时在读素材包之前就先刷上，加载页不会先闪一下默认色。

### 目前要手写清单

`tools/make-manifest.py` 还只扫贴纸 / 底板 / 桌面 / 音乐目录，`skin` 和 `skin-asset` 条目暂时手动写进 `entries`（不写 `sha256` 也能装，播放器安装时会自己算）。
