# feature-mini-simulator

演示窗格专用的仿真台。**独立产物**,不是主台子加开关 —— 那些 UI 在编译时就不进来。

- 产物: `dist/mini-simulator.html`(单文件, 约 9 MB, 离线可用)
- 前端入口: `MINI_SIMULATOR_URL`(`config.ts:24`, 默认 `/simulator/mini-simulator.html`),
  `MiniSimulator.tsx` 一处指过去, instructions 视图和 workflow 视图同时生效
- 计划书: `moonshot/doc/0924/plan-mini-simulator-standalone.md`

## 它做什么

收 `kb:init`(整套 86 件的场景)和 `kb:showStep`(第几步), 然后:

1. `step < n` 的**真零件**瞬间摆到 baked 终点位姿, 不动画
2. `step >= n` 的零件留在料盘(宿主给的坐标)
3. 第 n 步的真零件沿 baked 轨迹 `path[0] → path[-1]` 飞过去
4. 播完**冻结** —— 不续播下一步, 不提示
5. 只许转镜头和缩放, 不许拖零件、不许选中(页面里根本没有拾取代码)
6. 取景: 整机(`step <= n` 全在终点位姿)全在画面内 + 这一步的零件不被挡住

动的是 `KB.objectsRoot` 里的**真零件**。不是悬浮 1.35 的 overlay 副本 —— 上一版
那个做法已经作废。

## 界面上有什么

一块画布。没有工具栏、没有难度切换、没有属性面板、没有黄色播放条 `#answerBar`、
没有左上引导 `#nextGuide`、没有 toast、没有检查面板、没有教程、没有黄箭头和推荐
视角卡片。`tests/smoke_mini.py` 逐条验这些 DOM 和全局对象都不存在。

**唯一的例外是 46 步 debug 面板, 默认关**(计划书 §4.2)。不带 flag 时连节点都不
建, 只有 `window.KBStepDebug` 这个 API 对象;`?debugSteps=1` 或
`KBStepDebug.show(true)` 才在右上角列出 46 行, 点一行就按 mini 的方式演那一步
(init 到 n-1 + 装第 n)。它和主台子用**同一份 `src/stepdebug.js`**(字节一致,
8136 B), 主台子那边是 `kitbash-assembly-bench-patch/07-step-debug.patch`, 点一行
走 `KBAnswer.showStep(i)`。两边都能开, 就能把同一步并排比。

## 怎么构建

```bash
KB_NODE_PATH=/home/wenhel/dsta-stance-project/dsta-stance-clean-refactor-s2/moonshot/gin-dev-latest/external/aristos_frontend/node_modules \
  /home/wenhel/miniconda3/envs/gemmaft/bin/python build.py
```

`src/` 的中文注释在内联前剥掉(用主台子的 `tools/strip_comments.js`, TypeScript
的 parser, 不会把字符串里的 `//` 当注释)。剥离器找不到 node 或 typescript 就
**直接报错**, 不静默跳过 —— 静默跳过会把注释发出去而日志上看不出来。
`KB_NODE_PATH` 指一个装了 typescript 的 `node_modules`。

`build.py` 把 `index.html` + `src/*.js` + bowei 台子的 `vendor/` 和
`assets/parts/`(manifest + 20 个 GLB 的 base64)内联成一个文件。

零件库、kit 布局、baked 轨迹全部来自 bowei 台子的
`handle-callbacks/assets/parts/manifest.json`(它的 `answer` 字段就是
`answer_poses_full.json`: 46 步 / 74 件)。mini 这边不另存一份数据。

开发模式(不打包, 边改边看)需要 `python3 -m http.server` 起一个服务再开
`index.html` —— 目录里的 `vendor` / `assets` 是指向 bowei 台子的软链接。

## 怎么自测

```bash
P=/home/wenhel/miniconda3/envs/gemmaft/bin/python
$P tests/smoke_mini.py                      # 0 5 20 33 45
$P tests/smoke_mini.py $(seq 0 45)          # 全 46 步(~25 min, swiftshader 上 1-2 fps)
$P tests/smoke_host_contract.py             # step_map 的 46 个 uuid + 按名兜底 + 重播
$P ../feature-simulator-bowei/smoke_stepdebug.py   # ?debugSteps=1 面板, 两个产物都验
MINI_KIT=<kit_scene.json> $P tests/smoke_mini.py 0 45   # 喂生产那份场景
```

默认喂 bowei 台子的 `kit.json`。**生产喂的是前端的 `kit_scene.ts`** —— 同样
86 件, 但 Standoff Screw #9-12 只有 glb uuid 没有 `key`(走的是另一条解析
分支)。`MINI_KIT` 指一份从 `kit_scene.ts` 导出的 JSON 就能跑那条路径;
2026-09-26 实测第 0/45 步 **58/58**, 86/86 载入, 无 `kb:warn`。

三个坑, 踩了就是假结果:

- **"第 n 步演到位"必须看被画出来的帧**。对比 baked 数据的两端
  (`path[0] != path[-1]`)是恒真的, 零件一帧没动也照样过 —— 第 44/45 步整段
  飞行被跳过就是这么漏过去的(见下面 `KB.resetDelta`)。现在的判据是在
  `KB.onFrame` 里逐帧记真实位姿, 要求至少有一帧的零件严格处在 `path[0]` 和
  `path[-1]` 之间。父页面轮询不行:轮询和 iframe 的 rAF 共用主线程, 采样率
  等于帧率。

- **必须经 `tests/host.html` 驱动**。mini 的 bridge 只收**父窗口**发来的
  postMessage(`ev.source !== host` 直接丢), 在 mini 页面里自己 postMessage
  会被静默吃掉, 得到一个假的"没反应"。
- **必须走 http, 不能 `file://`**。file 下 iframe 是不透明源, 父页面读不到
  `contentWindow`, 报 SecurityError。`smoke_mini.py` 自己起一个临时 http 服务。

## 和主台子(bowei `handle-callbacks`)是什么关系

`src/` 从 **ca69f1e** 派生, 一份一份说清楚:

| 文件 | 来源 | 改了什么 |
|---|---|---|
| `src/core.js` | 新写, 内核函数逐字抄自 `src/app.js` | 见下 |
| `src/parts.js` | `ca69f1e:src/parts.js` | 砍掉零件栏和孔位标签两节 |
| `src/workspace.js` | `ca69f1e:src/workspace.js` | 只留 `bounds` / `center` 两个数 |
| `src/bridge.js` | `ca69f1e:src/bridge.js` | 只留 init / showStep / ready / warn |
| `src/mini.js` | 新写 | 演示逻辑 + 取景 |
| `src/mini.css` | 新写 | 只有画布 |

**`core.js` 替掉 `app.js`**: app.js 是 1538 行的编辑器主体, mini 只要它的内核。
逐字抄过来的是渲染器 / 灯光 / 地面 / `objectsRoot`(app.js:26-75)、`isPartNode`
(141)、`buildNode` / `clearSceneObjects` / `loadSceneData`(184-257)、`newId`
(438)、`highlight` / `partById`(711-726)、`flyCamera` 和镜头补间(1386-1410)。
没进来的: TransformControls、Raycaster 拾取、selection、undo/redo、
serializeScene、autosave、inspector、tree、toast、modal、tweens、group/fuse。
`OrbitControls` 关了 `enablePan`(平移会把算好的取景推走)。地面网格
(`GridHelper`)也没进来 —— 整机摆在 z=11, 原版那张 14 单位的网格一半在画外。

**没进来的模块**: `answer.js`(它开头就是 `if (!bar) return;` —— 没有
`#answerBar` 整个模块直接退出, 只能把要的部分抄出来)、`check.js`、`collide.js`、
`tray.js`、`mate.js`、`snap.js`、`levels.js`、`focus.js`、`guide.js`、`label.js`、
`help.js`、`record.js`、`stream.js`、`celebrate.js`、`tutorial*.js`。

`mini.js` 从 `answer.js` 抄了两段: `loadData()` 的路点换算(33-49)和 `poseAt()`
的弧长插值 + 四元数 slerp(157-172); 取景抄
`kitbash-assembly-bench-patch/retired/06-mini-camera.patch`, 把 ghost 的 `it.g`
换成真零件节点。三处和原版不同, 都是"虚影 → 真零件"带来的:

1. **落点**: answer.js 把整套零件 XZ 取均值居中、抬到 `HOVER=1.35` 的虚影 root 上;
   mini 按 `check.js` `refToWorld()` / `refLift()`(1282-1310)的口径 —— 参考原点平
   移到装配区中心 `(0, ·, 11)`, Y 抬到最低包围盒离台面 0.01(实测 lift=0.756)。
   这样 mini 里的整机和主台子里学员装出来的位置是同一个地方。
2. **取景仰角**: 06 的候选仰角全在水平线以上(`d.y` / 0.12 / 0.75)。参考装配是
   **倒着**采的(顶板在最下面, 标准件螺丝从下往上拧, 见 `answer_poses_full.json`
   第 29..34 步), 虚影悬在 1.35 时压低视角还能看到底面, 真零件贴着台面就看不到了
   —— 实测第 33 步 Standoff Screw #9 七个采样点全被 Top Plate 挡死。所以多加了
   -0.35 / -0.75 两档负仰角(台面只有一块 ShadowMaterial, 不挡视线)。
3. **同一步多件**: 按 `DUR=1.1s` + `GAP=0.18s` 一件一件飞(四颗螺丝同时进看不清
   谁进了哪个孔), 和 answer.js 的 `schedule()` 同样思路。**先后顺序必须是
   `answer_poses_full.json` 的原始顺序** —— 第 0 步是"先楔块, 后穿它的螺丝",
   排序里加第二关键字会把这两件对调, 演出"螺丝先飞到空中再等楔块过来"。
   `parts.sort` 只按 `step` 排(Array.sort 稳定), `tests/smoke_mini.py` 有一条
   专门验这个顺序。

**`KB.resetDelta()`**(`core.js` / `mini.js showStep`): `frameStep()` 的遮挡射线是
同步的, 后段步骤要一秒多(实测第 44 步 1347 ms、第 45 步 1338 ms, CPU 计时)。
`THREE.Clock.getDelta()` 会把这段时间全部记到下一帧的 `dt` 上, 而一次飞行只有
`DUR = 1.1 s` —— 结果 `t` 一步跨过 `maxT`, 零件直接出现在终点, **一帧中间姿态都
不画**, 看上去"这一步本来就装好了"。所以 `showStep` 在 `frameStep()` 之后手动清一
次 delta, 飞行从"射线算完"起算。A/B 实测(同一个包, 把 `KB.resetDelta` 换成空函数)
见下面"自测数字"。这是 mini 自己的 bug, 和主台子无关(`answer.js` 不做遮挡射线)。

**料盘不重排**: 原版 bridge 会把料盘零件按类型分格重摆(`KBTray.arrange`)。mini
没有 `tray.js`, 零件按宿主给的坐标摆 —— 等价于原版的 `options.tray === false`。
kit 的坐标在 z ≈ -140mm(≈ -3.5 单位), 装配区在 z = 6..16 单位, 不重叠。

## 取景的已知限度

"整机全在框内"和"这一步的零件看得清"是一对矛盾:一颗 M3x6 螺丝在整机里只占几个
像素。06 的算法(和 mini)选的是前者 —— 把镜头怼到螺丝上, 看到的是一个白点, 没有
上下文。所以自检验的是**几何上没被别的零件挡住**(实测第 0/5/20/33/45 步分别
67/67、7/7、7/7、6/7、5/6 个采样点无遮挡), 不是"一眼就能看出是哪颗"。要后者得
另加高亮或两段式镜头(先整机再推近), 那是新合约。

## 已知的、故意没做的

- **画布里的"重播"按钮**(计划书 §4.1 尾): 不做, **因为不需要** —— 宿主侧
  `MiniSimulator.tsx` 的 Replay 按钮重发同一条 `kb:showStep`, 实测(2026-09-26,
  `tests/smoke_host_contract.py` 13/13)第二次照样从 `path[0]` 重新飞:
  `sawPlaying` 为真, 被画出来的帧里最低 u = 0.001, 中间姿态 3 帧, 终点仍落在
  `path[-1]`(< 2e-4)。所以画面上除了 3D 什么都没有这一条保持不变。
  注意测这条有个坑:光等 `status().done` 会在重播前就满足(上一次播完就是 done),
  循环立刻退出 —— 必须先等 `playing` 起来再等 `done`。
- **第 2 步(X-Lock 合体)**: 数据里第 2 步(`972c5284-…`)其实是"把第 0、1 步预装
  好的两个楔块组件装到 X-Lock 上", `parts.js` 的 `assemblyAnswer()` 给它标了
  `assembly.groups`, `answer.js` 会让那两组零件从两侧平移进场。mini 按任务书的字面
  合约实现 —— 只演这一步自己的零件(X-Lock, 路点 2 个, 会飞), 第 0、1 步的四件已经
  在终点位姿上, 不会再滑进来。要改成"组件合体"的演法得先定合约。

## 自测数字(2026-09-26, headless swiftshader)

| 脚本 | 结果 |
|---|---|
| `tests/smoke_mini.py $(seq 0 45)` | **630/630**, 46 步全过, 无 pageerror, 无非 favicon 的失败请求 |
| `tests/smoke_host_contract.py` | **13/13** —— step_map 46 个 uuid 全解成不重复的 0..45, 按名兜底可用, 重播从头飞 |
| `../feature-simulator-bowei/smoke_stepdebug.py` | **48/48**, mini 和主台子两个产物的面板都验 |

`KB.resetDelta()` 的 A/B(同一个包, B 臂把它换成空函数;记的是**被画出来的帧**里
落在 `path[0]`~`path[-1]` 之间的次数):

| 步 | A(现状) | B(没有 resetDelta) |
|---|---|---|
| 20 | 2 | 1 |
| 33 | 2 | 1 |
| 44 | 2 | **0** |
| 45 | 2 | **0** |

B 臂第 44/45 步连一帧 `playing` 都没有 —— 整段飞行被 `frameStep` 的射线时间吃掉,
零件直接出现在终点。这就是这个 fix 要挡的。

**覆盖面**: headless Chrome + swiftshader(1-2 fps, 所以"这一步演到位"的判据是
"至少有一帧画在中间", 不是"看起来流畅"), 输入是真 `kit.json` 86 件和真
`answer_poses_full.json`。**未覆盖**: 真 GPU、真 `MiniSimulator.tsx` 嵌入
(React 那一层)、公网页面里的人眼确认。
