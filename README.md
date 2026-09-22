# 三维组装台 (Kitbash)

在浏览器中交互式组合基础几何体、搭建 3D 模型的工作台。零依赖构建,单文件即可运行。

## 运行

- 直接用浏览器打开 `dist/kitbash-standalone.html`(单文件,可随意分发),
- 或打开 `index.html`(开发版,引用 `src/` 与 `vendor/`,便于改代码)。

单文件版 `file://` 直接可用;开发版(`index.html`)需要本地服务器加载零件:

```bash
python3 serve.py        # 然后打开 http://localhost:8123
```

## 功能

| 操作 | 方式 |
| --- | --- |
| 零件来源 | 顶栏「Kit」载入 Frame Bottom Assembly 全套 24 件零件 |
| 选择 | 点击物体;`Shift`+点击多选;`Esc` 取消 |
| 移动 / 旋转 / 缩放 | `W` / `E` / `R` 切换 gizmo 模式,`Q` 切换世界/局部坐标系 |
| 网格吸附 | `V` 或顶栏「吸附」:移动 0.25 · 旋转 15° · 缩放 0.1 |
| 组合 / 解组 | `Ctrl+G` / `Ctrl+Shift+G`(组合后作为整体变换,视口点击选中整组) |
| 复制 / 删除 | `Ctrl+D` / `Delete` |
| 撤销 / 重做 | `Ctrl+Z` / `Ctrl+Shift+Z` |
| 视角 | 左键拖动旋转,右键拖动平移,滚轮缩放,`F` 或双击聚焦选中物体 |
| 属性 | 右侧面板:名称、位置/旋转/缩放数值、颜色、金属度、粗糙度、不透明度 |
| 保存 | 自动保存到浏览器 localStorage;「JSON」导出可再次「导入」编辑 |
| 导出模型 | 「GLB」导出二进制 glTF,可直接用于 Blender / 网页 / 游戏引擎 |
| 直接拖拽 | 鼠标按住物体拖动;Shift+拖 = 垂直升降;拖空白处转视角 |
| 归位 `S` / Snap all | 选中零件按 `S`:离参考装配里的正确位姿够近(10 mm + 25° 以内,长零件按角度差该甩出的距离放宽)就吸到精确位置,够不着会提示。**默认不自动吸**(会和手上的微调打架),要放下即吸用 `KBCheck.autoSnap(true)`。Checks 面板的 **Snap all** 一次归位所有够得着的零件(分轮推进:每轮只吸有正确参照的,吸好的成为下一轮参照)。插反的螺丝不吸 |
| Checks 说明 | 问题条目会写清差在哪("8.0 mm too high" / "sideways"),点一下条目会在**正确位置**画出半透明绿色虚影(再点一次收起);相同零件互换不算错,槽位由相对位姿自动匹配 |
| Tutorial | 顶栏 Tutorial(或 `?tutorial=1`):几个小课,每课两个零件,做完自动换零件——课 1 机臂 + 前板(孔对孔、绕孔转),课 2 楔块 + 螺丝(销入孔、沿孔推拉);要点的孔口会聚光,点错了拒绝并提示 |
| 孔位反推 | `python3 tools/holes_from_answer.py <key> [--write] [--out f.json]`:贡献方文件只标了任务用到的孔时,用参考装配里伙伴零件的销轴反推出其余孔的**位置**(与最终安装位置一致),再用网格射线量出孔径与深度;`--write` 直接补进 manifest,`--out` 生成 contributor 文件回写数据库。已用它补上机臂的 4 个电机安装孔 |
| 孔位标注 | Expert 模式 → Properties → **Features**:列出选中零件的 H/P(直径 / 深度可改、可删);按 **Label** 后把鼠标移到零件的孔里(长槽、多边形孔也行),实时拟合出圆和轴,点一下加上。标注存在浏览器里,**Export** 导出 contributor 格式 `part_features.json`,再 `python3 tools/features_db.py import <db> part_features.json` + `manifest` 重新生成 manifest |
| General / Expert | 顶栏第一个按钮切换(记住上次选择,`?expert=1` 强制)。**General(默认)**:选中只亮孔位,没有 gizmo 坐标轴和包围盒,用下面三行操作;**Expert**:原来的 gizmo、Move/Rotate/Scale、World/Local、网格吸附、Ctrl 拖动吸附 |
| 点网格移动 | 选中零件后点空白网格 → 零件平移到那个点(高度不变);`↑`/`↓` 升降 0.5 mm(Shift 0.1 mm),`←`/`→` 偏航 1°(Shift 90°);右键点一下 / Esc / Shift+点空白取消选择 |
| 点选装配 | 选中零件后点它的一个孔/销(圆片),再点另一个零件的孔/销 → 先飞到孔轴前、再沿轴插入(销插孔、孔套销、孔叠孔,端面贴平)。**每个孔上下各一个孔口圆片,点的两个孔口贴在一起**(想让板子正着落到下面的东西上,就点板子的下孔口);装上后零件锁在孔上(拖拽 / 点网格不动它,再点一下零件解锁),方向键相对孔轴:`↑`/`↓` 沿轴拔出/推入 0.25 mm(Shift 0.05 mm),`←`/`→` 绕轴转 1°(Shift 90°);Expert 模式下枢轴同时落到孔上;销对销 / 销比孔粗会拒绝并提示 |
| 装配吸附 | **按住 Ctrl 生效**(默认自由移动):面-面贴平后沿面滑动;轴-轴(销入孔/孔对孔)对中后沿轴滑动,拖远脱开;直接拖拽与 gizmo 平移/旋转统一 |
| 零件库 | aristos 无人机机架 10 个真实零件(碳板/机臂/螺丝/螺柱等),孔位与销轴已自动标注并参与吸附 |
| 零件桌(Kit) | 从 ARISTOS task_graphs.db 生成的 82 件零件按类型成排摆在桌面上(板状件自动放平),每件带任务图实例 UUID |
| 录屏 | 顶栏「Rec」:浏览器内录制本页为 WebM(选"当前标签页",可混麦克风),再点停止并保存 |
| 直播小窗 | 顶栏「Agent」→ Live view:`python3 monitor.py` 后点 Share view,任何浏览器/设备打开 http://127.0.0.1:8124 即可实时观看,支持画中画悬浮窗;`/embed` 可嵌入 iframe,`/frame.jpg` 供程序取帧 |
| Agent 推流 | 同一面板 → Assembly agent:把视口帧按变化/心跳 POST 给 animation_new/agent_server.py 的 /predict,面板内显示识别到的装配阶段 |
| 失败检测 | 顶栏「Checks」:每次放下后按场景状态重算 —— 零件是否**相对其配合件**到位(3.2mm / 12°,考虑旋转对称,相同零件可互换,子装配在桌上任何地方拼都算);每步 complete / available / premature / blocked(按任务图依赖 DAG,不是线性清单);放错孔位、用错零件、螺丝装反、乱序提示。见 docs/STEP_COMPLETION.md。相同零件可互换,且识别零件自身的旋转对称(楔块绕 z 180°、板绕长轴 180°),对称等价的摆法视为正确;暂不区分 M3×16 盘头/杯头 |
| 下一步 | 顶栏「Next」:把下一个可做步骤的参考轨迹贴到**你当前的装配体**上循环播放,并高亮该拿的零件;放下零件后自动刷新/切步 |
| 受训者模式 | `?trainee=1`(嵌入 ARISTOS 时默认):隐藏缩放/删除/复制/分组/材质编辑,只留装配 |
| 答案演示 | 顶栏「Answer」:半透明虚影按装配顺序落位(27 步 / 53 件,步骤顺序、接近→落位轨迹、前置依赖全部由 `features_db.py answer` 从 task_graphs.db 生成);Checks 的装配顺序规则用同一份前置依赖 |

接手 ARISTOS 那一侧开发的人从 [docs/ARISTOS_HANDOVER.md](docs/ARISTOS_HANDOVER.md) 开始(现状 / 要做什么 / 怎么跑 / 踩过的坑);
接口参考见 [docs/ARISTOS_INTEGRATION.md](docs/ARISTOS_INTEGRATION.md);孔位数据规范见 [docs/FEATURE_SCHEMA.md](docs/FEATURE_SCHEMA.md)。

## 结构

```
index.html          页面结构(开发版入口)
src/app.css         界面样式
src/app.js          编辑器逻辑(场景/选择/变换/组合/撤销/导入导出)
src/snap.js         装配吸附(面-面 / 轴-轴)+ 直接拖拽
src/mate.js         点选装配(点孔 → 点孔/销,两下装上)
src/tutorial.js     新手教程(三个零件走一遍)
src/label.js        孔位标注工具(Expert;拟合鼠标下的孔,导出 part_features.json)
tools/holes_from_answer.py  从参考装配反推缺失的孔(伙伴销轴 → 轴线,网格射线 → 孔径/深度)

注:electric 电机模型(motor_2207.glb)由 4624 个独立壳体组成(绕组、卡簧等),
不能整体做边塌缩简化 —— 会把各个壳体缝在一起、炸成碎片。要减面请按连通体
逐个简化(trimesh split → fast_simplification,小于 200 面的壳体原样保留)。
src/parts.js        零件库(GLB 加载、孔位标签可视化、吸附特征供给)
src/answer.js       答案虚影动画(步骤时间轴)
src/record.js       网页内录屏(MediaRecorder)
src/stream.js       直播推流(monitor.py)/ agent 推流(agent_server.py)
src/check.js        失败检测面板(尺寸/长度/错件/错孔/顺序/评分)
assets/parts/       零件 GLB + manifest.json(20 种零件的孔位/对称性/Kit 布局,由 ARISTOS task_graphs.db 生成)
tools/features_db.py  孔位/销轴作为贡献者数据进 task_graphs.db(PartTypeFeatures / PartTypeSymmetries):
                      detect 自动检测入库 → 贡献者复核 → manifest 从库生成(见 docs/FEATURE_SCHEMA.md)
tools/scene_from_db.py 从 task_graphs.db 生成 <Simulator> 的 initialScene:--layout installed(装配位姿)/ kit(零件摆桌上)
tools/label_holes.py  孔位检测算法本体(圆柱面聚类 + 圆拟合 + 回转体回退),被 features_db.py 调用
integration/react/  <Simulator> React 组件(Dana 的签名:initialScene / onGrab / onMove / onPlace / onViewUpdate)+ 演示
vendor/             three.js r147 (UMD) + 控制器/加载导出器
build.py            打包脚本(零件库内嵌 base64):python3 build.py → dist/
serve.py            本地开发服务器:python3 serve.py
monitor.py          直播中继(MJPEG):python3 monitor.py → http://127.0.0.1:8124 观看
dist/               单文件产物(standalone 本地用 / artifact 发布用)
```

## 零件库与孔位标注

零件 mesh 来自 `/home/lbw/moonshot/aristos`(Lumenier QAV-S 2 机架)。原数据没有孔位
标注,`tools/label_holes.py` 从网格几何自动检测:对每个候选轴向取圆柱侧壁三角面,
邻接聚类 + 最小二乘圆拟合(螺纹碎裂时回退到回转体半径分带),法线朝内为孔(H)、
朝外为销(P),结果写入 `assets/parts/manifest.json`(圆心/轴向/半径/深度,编辑器单位)。
选中零件时孔位显示琥珀色圆环 + H 标签,销轴显示蓝色。螺丝拖近孔位即自动对中
(⌀3 销优先匹配 ⌀3 孔),Shift+拖沿孔轴推入。

改动 `src/` 后重新运行 `python3 build.py` 即可更新单文件版本。
