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
| 装配吸附 | **按住 Ctrl 生效**(默认自由移动):面-面贴平后沿面滑动;轴-轴(销入孔/孔对孔)对中后沿轴滑动,拖远脱开;直接拖拽与 gizmo 平移/旋转统一 |
| 零件库 | aristos 无人机机架 10 个真实零件(碳板/机臂/螺丝/螺柱等),孔位与销轴已自动标注并参与吸附 |
| 示例场景 | Frame Bottom Assembly 全套零件清单(24 件,数量取自装配任务图 BOM) |
| 录屏 | 顶栏「Rec」:浏览器内录制本页为 WebM(选"当前标签页",可混麦克风),再点停止并保存 |
| 直播小窗 | 顶栏「Agent」→ Live view:`python3 monitor.py` 后点 Share view,任何浏览器/设备打开 http://127.0.0.1:8124 即可实时观看,支持画中画悬浮窗;`/embed` 可嵌入 iframe,`/frame.jpg` 供程序取帧 |
| Agent 推流 | 同一面板 → Assembly agent:把视口帧按变化/心跳 POST 给 animation_new/agent_server.py 的 /predict,面板内显示识别到的装配阶段 |
| 失败检测 | 顶栏「Checks」:以 X-Lock 为基准对照标准答案 —— 完成度评分、放错孔位/位置偏差、用错零件(如 M3×16 放在 M3×22 位)、螺丝方向装反、装配顺序(前板先于机臂)。相同零件可互换,且识别零件自身的旋转对称(楔块绕 z 180°、板绕长轴 180°),对称等价的摆法视为正确 |
| 答案演示 | 顶栏「答案」:半透明虚影按装配顺序落位,循环演示最终装配位姿(位姿来自 aristos step_3d_paths.json);再点关闭 |

## 结构

```
index.html          页面结构(开发版入口)
src/app.css         界面样式
src/app.js          编辑器逻辑(场景/选择/变换/组合/撤销/导入导出)
src/snap.js         装配吸附(面-面 / 轴-轴)+ 直接拖拽
src/parts.js        零件库(GLB 加载、孔位标签可视化、吸附特征供给)
src/answer.js       答案虚影动画(步骤时间轴)
src/record.js       网页内录屏(MediaRecorder)
src/stream.js       直播推流(monitor.py)/ agent 推流(agent_server.py)
src/check.js        失败检测面板(尺寸/长度/错件/错孔/顺序/评分)
assets/parts/       无人机机架零件 GLB + manifest.json(孔位标注,来自 aristos)
tools/label_holes.py  孔位检测标注:圆柱面聚类 + 圆拟合,孔 H1..Hn / 销 P1..Pn
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
