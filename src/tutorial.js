/* ============================================================
 * 新手教程 — 几个小课,每课两个零件,做完一课自动换下一课的零件
 *
 *   课 1「绕孔转」:机臂 + 前板 —— 选中机臂 → 机臂孔套到前板孔上(孔对孔)→ ←→ 绕孔转
 *   课 2「插入」  :楔块 + 螺丝 —— 选中螺丝、点螺丝杆 P1 → 点楔块的孔(销入孔)→ ↑↓ 沿孔推拉
 *   要点的孔口会聚光;点错了拒绝并提示该点哪个。做对了自动进下一步,也可以 Skip。
 *   顶栏 Tutorial 按钮或 ?tutorial=1 启动;× 退出。
 * ============================================================ */
(function () {
  'use strict';

  var KB = window.KB;
  var HL = 0x3d7be8; // 蓝色高亮:这一步要碰的零件

  var el = document.getElementById('tutorial');
  var barEl = el.querySelector('.tt-bar i');
  var bodyEl = el.querySelector('.tt-body');
  var stepEl = el.querySelector('.tt-step');
  var textEl = el.querySelector('.tt-text');
  var hintEl = el.querySelector('.tt-hint');
  var nextBtn = document.getElementById('ttNext');
  var closeBtn = document.getElementById('ttClose');

  var stageEl = el.querySelector('.tt-stage');
  var inputsEl = el.querySelector('.tt-inputs');
  var actionsEl = el.querySelector('.tt-actions');
  var choiceEl = document.getElementById('ttChoice');
  var statusEl = el.querySelector('.tt-status');
  var advanceTimer = 0;
  var introTimers = [];
  var completed = {};
  var onboarding = false;
  var currentSelection = [];

  var parts = null;   // 当前课的零件 {arm, plate} / {wedge, screw}
  var idx = -1;
  var timer = 0;
  var lit = [];
  var flags = {};     // 事件观察:本步开始后发生过什么

  /* ---------- 课程:每课自己的零件、镜头、步骤 ---------- */
  function o(key, name, p, r) {
    return { id: KB.newId(), name: name, type: 'part:' + key, p: p, r: r || [0, 0, 0], s: [1, 1, 1] };
  }
  // 教程一律在装配区里上课(KBWorkspace.bounds 的中心在 z = 11),镜头也跟着挪过去
  var ORBIT_DRAGS = 3;   // 要分开拖三次视角
  var PAN_DRAGS = 2;     // 右键平移练两次
  var ZOOMS = 2;         // 滚轮缩放练两次
  var AREA_HOPS = 3;     // 两个区之间来回跳三次
  var VIEW = { p: [3.9, 4.8, 17.6], t: [1.0, 0.3, 11.8] };
  var courses = [
    {
      name: 'Find your way', names: { plate: 'Front Plate', arm: 'Arm' },
      view: { p: [0, 6.2, 13.5], t: [0, 0.3, 10.5] },
      scene: function () {
        // 两件零件摆在装配区里,转视角时有东西可看
        return [o('split_front_plate', 'Front Plate', [-0.6, 0, 10.6]), o('arm_5in', 'Arm', [1.1, 0, 10.9], [0, Math.PI / 2, 0])];
      },
      steps: [
        { tag: 'orbit', light: function () { return []; },
          done: function () { return (flags.orbitDrags || 0) >= ORBIT_DRAGS; },
          lesson: { title: 'Look at it from another side', hint: 'Drag on empty space with the LEFT mouse button to swing the view around. Do it a few times, from different sides: which disc of a hole you can click depends on where you are looking from.',
            demo: 'move', label: 'Drag empty space to orbit', target: 'View',
            actions: ['Press and hold on empty space, drag until the parts turn',
                      'Let go and do it again \u2014 ' + ORBIT_DRAGS + ' separate drags'] } },
        { tag: 'pan', light: function () { return []; },
          done: function () { return (flags.panDrags || 0) >= PAN_DRAGS; },
          status: function () {
            if ((flags.panDrags || 0) >= PAN_DRAGS) return '';
            return 'Panned ' + (flags.panDrags || 0) + ' of ' + PAN_DRAGS + ' times \u2014 hold the RIGHT mouse button and drag.';
          },
          lesson: { title: 'Slide the view sideways', hint: 'Hold the RIGHT mouse button and drag: the view slides without turning. That is how you bring a far corner of the tray, or the other side of the workspace, into the middle of the screen.',
            demo: 'move', label: 'Right-drag to pan', target: 'View',
            actions: ['Hold the right mouse button and drag the view sideways',
                      'Do it ' + PAN_DRAGS + ' times \u2014 put something else in the middle'] } },
        { tag: 'zoom', light: function () { return []; },
          done: function () { return (flags.zooms || 0) >= ZOOMS; },
          status: function () {
            if ((flags.zooms || 0) >= ZOOMS) return '';
            return 'Zoomed ' + (flags.zooms || 0) + ' of ' + ZOOMS + ' times \u2014 roll the mouse wheel.';
          },
          lesson: { title: 'Get closer, then back out', hint: 'Roll the mouse wheel to zoom. Close up you can tell two holes apart and click the right disc; zoomed out you can see the whole frame at once.',
            demo: 'adjust', label: 'Wheel to zoom', target: 'View',
            actions: ['Roll the wheel forward to come closer',
                      'Roll it back to pull out \u2014 ' + ZOOMS + ' zooms in all'] } },
        { tag: 'areas', light: function () { return []; },
          done: function () { return (flags.areaCount || 0) >= AREA_HOPS; },
          lesson: { title: 'Two areas: tray and workspace', hint: 'Parts wait in the tray, sorted by kind; screws are split by length. You assemble in the workspace in front of it. The toolbar button jumps between them \u2014 or press B. Hop back and forth a few times so you know where each one is.',
            demo: 'adjust', label: 'Press B, or click Parts tray', target: 'View',
            actions: ['Press B (or click the button in the toolbar)',
                      'Hop between the two areas ' + AREA_HOPS + ' times'] } }
      ]
    },
    {
      name: 'Insert a screw', names: { wedge: 'Wedge', screw: 'Screw' },
      preview: { source: { name: 'Screw', id: 'P1', end: 0 }, target: { name: 'Wedge', id: 'H1', end: 1 } },
      view: { p: [1.7, 1.9, 13.8], t: [0.6, 0.1, 11.3] }, // 小零件,镜头凑近
      scene: function () {
        return [o('aluminum_arm_wedge_5mm', 'Wedge', [0, 0, 11]), o('screw_m3x16_socket_cap', 'Screw', [1.4, 0, 11.9])]; // 楔块平放,孔是横着的:螺丝横着插进去
      },
      steps: [
        // 装配永远是三下:① 点要动的零件 ② 点它身上的孔 / 销 ③ 点它要去的那个孔
        { tag: 'pickScrew', previewTag: 'armScrew', light: function () { return []; },
          focus: function () { return { nodes: [parts.screw] }; },
          done: function () { return flags.selected === parts.screw; },
          lesson: { title: '1 \u00b7 First click the part you want to move', hint: 'Every connection is three clicks, always in this order: the part, its hole, then the hole it goes into. Start with the part: click the screw. Its connection discs appear on it.',
            demo: 'arm', label: 'Click the screw', target: 'Screw', actions: ['Click the yellow screw', 'Its discs appear \u2014 holes pink, pegs purple'] } },
        { tag: 'armScrew', light: function () { return [parts.screw]; },
          expect: function () { return { source: [{ node: parts.screw, id: 'P1', end: 0 }], target: [] }; },
          done: function () { var a = KBMate.armed(); return !!a && a.node === parts.screw && a.id === 'P1'; },
          lesson: { title: '2 \u00b7 Then click its hole or peg', hint: 'Now click the disc on the part that makes the connection \u2014 here the cyan one on the screw\u2019s shaft. It turns green: that end is the one that goes in.',
            demo: 'arm', label: 'Click the shaft disc', target: 'Screw', actions: ['Click the cyan disc on the shaft', 'It turns green \u2014 ready to connect'] } },
        { tag: 'mateScrew', light: function () { return [parts.wedge]; },
          expect: function () { return { source: [{ node: parts.screw, id: 'P1', end: 0 }], target: [{ node: parts.wedge, id: 'H1' }] }; },
          done: function () { return flags.mate && flags.mate[0] === parts.screw && flags.mate[1] === parts.wedge; },
          lesson: { title: '3 \u00b7 Last, click the hole it goes into', hint: 'Only now click the hole where it belongs \u2014 the cyan disc on the wedge. The screw flies over and seats itself in that hole.',
            demo: 'insert', label: 'Click the wedge hole', target: 'Wedge hole', actions: ['Keep the shaft disc green', 'Click the cyan disc on the wedge'] } },
        { tag: 'slide', light: function () { return [parts.screw]; },
          done: function () { return slidMm() >= SLIDE_GOAL_MM; },
          status: function () {
            if (!flags.slideBase || slidMm() >= SLIDE_GOAL_MM) return '';
            if (!(window.KBMate && KBMate.hingeFor(parts.screw))) return 'Click the screw once to take hold of it again, then press \u2191 or \u2193.';
            return 'Slid ' + slidMm().toFixed(2) + ' mm of ' + SLIDE_GOAL_MM + ' mm \u2014 keep pressing \u2191 or \u2193.';
          },
          lesson: { title: 'Push and pull', hint: 'The screw is locked in that hole. \u2191 / \u2193 slide it along the hole (Shift = fine steps).',
            demo: 'adjust', label: 'Slide \u2191 \u2193', target: 'Screw', actions: ['Press \u2191 or \u2193', 'Watch the screw move along the hole'] } }
      ]
    },
    {
      name: 'Turn on a hole', names: { arm: 'Arm', plate: 'Front Plate' },
      preview: { source: { name: 'Arm', id: 'H1', end: -1 }, target: { name: 'Front Plate', id: 'H6', end: 1 } },
      scene: function () {
        // 教程卡片占着画面左边,零件整体靠右摆,免得藏在卡片后面
        return [o('split_front_plate', 'Front Plate', [1.8, 0, 10.4]), o('arm_5in', 'Arm', [0.8, 0, 13.2], [0, Math.PI / 2, 0])];
      },
      steps: [
        { tag: 'select', light: function () { return [parts.arm]; },
          done: function () { return flags.selected === parts.arm; },
          lesson: { title: 'Meet your first part', hint: 'The glowing arm is your target. A single click selects it and reveals its hole.',
            demo: 'select', label: 'Click to select', target: 'Arm', actions: ['Find the glowing arm', 'Left-click it once'] } },
        { tag: 'move', light: function () { return [parts.arm]; },
          done: function () { return flags.placed === parts.arm; },
          lesson: { title: 'Move it closer', hint: 'The selected part flies to the spot you click on the grid. Its height stays the same; \u2191 / \u2193 raise or lower it.',
            demo: 'move', label: 'Click an empty spot', target: 'Arm', actions: ['Keep the arm selected', 'Left-click an empty spot on the grid near the plate'] } },
        { tag: 'mateArm', light: function () { return [parts.arm, parts.plate]; },
          expect: function () { return { source: [{ node: parts.arm, id: 'H1', end: -1 }], target: [{ node: parts.plate, id: 'H6', end: 1 }] }; },
          done: function () { return flags.mate && flags.mate[0] === parts.arm && flags.mate[1] === parts.plate; },
          lesson: { title: 'Set the arm on the plate', hint: 'The two glowing discs will touch: the LOWER disc of the arm hole and the TOP disc of the plate hole. Tilt the view a little to reach the lower one.',
            demo: 'mate', label: 'Click source \u2192 click target', target: 'Plate hole', actions: ['Click the glowing LOWER disc of the arm hole', 'Click the glowing disc on the plate'] } },
        { tag: 'turn', light: function () { return [parts.arm]; },
          done: function () { return turnedDeg() >= TURN_GOAL; },
          status: function () {
            if (!flags.turnBase) return '';
            if (turnedDeg() >= TURN_GOAL) return '';
            var held = window.KBMate && KBMate.hingeFor(parts.arm);
            if (!held) return 'Click the arm once to take hold of it again, then press \u2190 or \u2192.';
            return 'Turned ' + Math.round(turnedDeg()) + '\u00b0 of ' + TURN_GOAL + '\u00b0 \u2014 hold \u2190 or \u2192 (Shift = 90\u00b0).';
          },
          lesson: { title: 'Turn it on the hole', hint: 'The arm is locked on that hole. \u2190 / \u2192 turn it around the hole, 1\u00b0 a press (Shift = 90\u00b0). Turn it at least 10\u00b0.',
            demo: 'adjust', label: 'Turn \u2190 \u2192', target: 'Arm', actions: ['Hold \u2190 or \u2192 (1\u00b0 a press, Shift = 90\u00b0)', 'Watch the arm swing around the hole'] } }
      ]
    }
    ,
    {
      // Level 1 只教一件事:点零件,它自己飞到位。没有圆片,不用对孔
      name: 'Click to place', names: { wedge: 'Wedge', screw: 'Screw' },
      // 螺丝在料盘里(装配区外),楔块在装配区:点螺丝,它自己一路飞进楔块 —— 和正式装配一样
      view: { p: [5.2, 8.2, 18.5], t: [0.7, 0, 6.8] },
      scene: function () {
        return [o('aluminum_arm_wedge_5mm', 'Wedge', [0, 0, 11]), o('screw_m3x16_socket_cap', 'Screw', [1.4, 0, 1.5])];
      },
      steps: [
        { tag: 'clickScrew', light: function () { return []; },
          // 和正式装配一样:整件发黄 + 头顶箭头,镜头自己飞到这个零件
          focus: function () { return { nodes: [parts.screw], fly: parts.screw }; },
          done: function () { return flags.mate && flags.mate[0] === parts.screw && flags.mate[1] === parts.wedge; },
          lesson: { title: 'Click a part \u2014 it goes in by itself', hint: 'On Level 1 you never line anything up. The part you need turns yellow with a yellow arrow above it; click it and it flies straight to where it belongs \u2014 here, into the wedge.',
            demo: 'arm', label: 'Click the glowing screw', target: 'Screw', actions: ['Click the yellow screw (the arrow points at it)', 'Watch it fly into the wedge hole'] } }
      ]
    }
    ,
    {
      // 正式装配里的两个帮手:黄色高亮 + 箭头(下一个要拿的零件)、右上角的推荐视角卡片
      name: 'Your helpers', names: { wedge: 'Wedge', screw: 'Screw' },
      // 镜头先对着装配区里的楔块,要用的螺丝远在料盘里、看不见 —— 推荐视角正是干这个的
      view: { p: [1.9, 2.6, 15.6], t: [0.6, 0.1, 11.2] },
      scene: function () {
        return [o('aluminum_arm_wedge_5mm', 'Wedge', [0, 0, 11]), o('screw_m3x16_socket_cap', 'Screw', [1.4, 0, 1.5])];
      },
      steps: [
        { tag: 'suggest', light: function () { return []; },
          focus: function () { return { nodes: [parts.screw], card: { node: parts.screw, caption: 'Close-up: Screw' } }; },
          done: function () { return flags.viewTip === 'used'; },
          status: function () { return flags.viewTip === 'dismissed' ? 'That hid the card. It comes back with the next part \u2014 press \u201cUse this view\u201d to try it.' : ''; },
          lesson: { title: 'Suggested view: find the part in one click', hint: 'The part you need is often far away in the tray, out of sight \u2014 like the screw for this wedge. The card in the top-right corner previews a close-up of it. \u201cUse this view\u201d flies the camera there, and from then on the camera follows each part as it moves into place. \u201cNot now\u201d only hides the card.',
            demo: 'arm', label: 'Click \u201cUse this view\u201d', target: 'View', actions: ['Look at the preview in the top-right card', 'Click \u201cUse this view\u201d \u2014 the camera flies to the part'] } },
        { tag: 'glow', light: function () { return []; },
          // 一二级:镜头自己飞到要用的零件(正式装配里也是这样);三级在上一屏已经用推荐视角过去了
          focus: function () { return { nodes: [parts.screw], fly: level <= 2 ? parts.screw : null }; },
          done: function () { return flags.selected === parts.screw; },
          // hint 按难度在 buildPlan 里填(GLOW_HINTS)
          lesson: { title: 'Yellow means \u201cthis one next\u201d', hint: '',
            demo: 'arm', label: 'Click the yellow part', target: 'Screw', actions: ['Find the part with the yellow arrow above it', 'Click it to select it'] } }
      ]
    },
    {
      // 第二遍:换一对零件自己再做一次,提示少一点
      name: 'Once more: arm onto plate', names: { arm: 'Arm', plate: 'Front Plate' },
      // 教程卡片占着画面左边(下半截也是):零件整体往右摆,镜头也对着右边,要点的孔别藏在卡片后面
      // 零件和"Turn on a hole"那课摆得一样(装好后整组还在装配区里);镜头的注视点放到左边,
      // 零件落在画面右半边,要点的孔别藏在左下角的教程卡片后面
      view: { p: [0.6, 5.4, 17.8], t: [-0.6, 0, 11.6] },
      scene: function () {
        return [o('split_front_plate', 'Front Plate', [1.8, 0, 10.4]), o('arm_5in', 'Arm', [0.8, 0, 13.2], [0, Math.PI / 2, 0])];
      },
      steps: [
        // 一级:点机臂,它自己装到前板上
        { tag: 'clickArm', light: function () { return []; },
          focus: function () { return { nodes: [parts.arm], fly: parts.arm }; },
          done: function () { return flags.mate && flags.mate[0] === parts.arm && flags.mate[1] === parts.plate; },
          lesson: { title: 'Your turn again: the arm', hint: 'Same idea with a different part. Click the yellow arm \u2014 it goes onto the plate by itself.',
            demo: 'arm', label: 'Click the arm', target: 'Arm', actions: ['Click the yellow arm', 'Watch it land on the plate'] } },
        // 二三级:三下点击自己做一遍
        { tag: 'pickArm', light: function () { return []; },
          focus: function () { return { nodes: [parts.arm] }; },
          done: function () { return flags.selected === parts.arm; },
          lesson: { title: 'Your turn again: 1 \u00b7 the part', hint: 'Now without help: the same three clicks with a different part. First the part \u2014 click the arm.',
            demo: 'arm', label: 'Click the arm', target: 'Arm', actions: ['Click the arm'] } },
        { tag: 'armArm', light: function () { return [parts.arm]; },
          expect: function () { return { source: [{ node: parts.arm, id: 'H1', end: -1 }], target: [] }; },
          done: function () { var a = KBMate.armed(); return !!a && a.node === parts.arm && a.id === 'H1'; },
          lesson: { title: '2 \u00b7 its hole', hint: 'Then its hole: click the cyan disc on the arm (the lower face of the hole \u2014 tilt the view if you need to).',
            demo: 'arm', label: 'Click the arm\u2019s hole', target: 'Arm hole', actions: ['Click the cyan disc on the arm'] } },
        { tag: 'mateArm2', light: function () { return [parts.plate]; },
          expect: function () { return { source: [{ node: parts.arm, id: 'H1', end: -1 }], target: [{ node: parts.plate, id: 'H6', end: 1 }] }; },
          done: function () { return flags.mate && flags.mate[0] === parts.arm && flags.mate[1] === parts.plate; },
          lesson: { title: '3 \u00b7 the hole it goes into', hint: 'Last, the hole where it goes: the cyan disc on top of the plate. The arm seats itself.',
            demo: 'insert', label: 'Click the plate hole', target: 'Plate hole', actions: ['Click the cyan disc on the plate'] } }
      ]
    }
  ];
  // 卡住时:顶部的 Help 按钮(每个难度最后都教一下)
  var HELP = { tag: 'help', light: function () { return []; },
    done: function () { return !!flags.help; },
    lesson: { title: 'Stuck? Press Help', hint: 'The Help button at the top (it glows now) opens a small card with a short animation of exactly where to click for the step you are on. It also starts to glow by itself if you have been stuck for a while. Press it now.',
      demo: 'arm', label: 'Press Help at the top', target: 'Help', actions: ['Press the glowing Help button at the top', 'Watch where the cursor clicks'] } };
  // 左上角的逐步指引:收起时是个小胶囊(第几步 + 进度),点开是这一步的零件清单
  var GUIDE = { tag: 'guide', light: function () { return []; },
    done: function () { return !!flags.guideFolded && !!flags.guideOpened; },
    lesson: { title: 'That card top-left checked your move', hint: 'The card in the top-left corner is your step guide. It checked every click you just made: each one turned green as soon as it was right, the card turns red and says what is wrong when it is not, and it says \u201cStep complete\u201d at the end. In the real build it lists the parts of each step the same way, and it stays there the whole time. Fold it into a small pill with \u2013, then click the pill to open it again.',
      demo: 'arm', label: 'Fold it, then open it', target: 'Guide', actions: ['Click \u2013 on the card to fold it into a pill', 'Click the pill to open it again'] } };
  // 每个难度上哪几课、跳过哪几步:一级只教看 + 点零件;二级教点孔(自己会落位,不教方向键);三级全套
  var PLAN = {
    // 一二级没有推荐视角卡片(镜头自己转过去),那一屏不教
    // 核心操作都练两遍:一遍螺丝进楔块,一遍机臂装到前板上
    1: { courses: [0, 4, 3, 5], skip: { suggest: 1, pickArm: 1, armArm: 1, mateArm2: 1 } },
    2: { courses: [0, 4, 1, 5], skip: { slide: 1, suggest: 1, clickArm: 1 } },
    3: { courses: [0, 4, 1, 2], skip: {} }
  };
  var FINALS = {
    1: { hint: 'The glowing part is the one to pick next. Click it and it moves into place; stuck? Press Help at the top for a short how-to.',
      actions: ['Find the glowing part', 'Click it \u2014 it flies into place', 'Stuck? Press Help at the top'] },
    2: { hint: 'Select the glowing part, click its glowing hole, then click the hole it goes into. The part seats itself \u2014 no fine-tuning needed.',
      actions: ['Click the glowing part', 'Click its glowing hole', 'Click the receiving hole'] },
    3: { hint: 'Select a part, click its hole, click the receiving hole. Arrow keys fine-tune on the hole. New puts the whole kit on the bench.',
      actions: ['Click a part to select', 'Click hole \u2192 hole to assemble', 'Use arrow keys to adjust the fit'] }
  };
  var GLOW_HINTS = {
    auto: 'The part you need is often far away in the tray, so the camera flies there for you. The part turns yellow and a yellow arrow bobs above it \u2014 even in a tray full of look-alike screws. Click the yellow screw.',
    card: 'There it is. The part you need next turns yellow and a yellow arrow bobs above it \u2014 even in a tray full of look-alike screws. Click the yellow screw.'
  };
  var FINAL = { light: function () { return []; }, done: function () { return false; },
    lesson: { title: 'You\u2019ve got the basics', hint: 'Select a part, click its hole, click the receiving hole. Arrow keys fine-tune on the hole. New puts the whole kit on the bench.',
      demo: 'complete', label: 'Ready for the full assembly', target: '', actions: ['Click a part to select', 'Click hole \u2192 hole to assemble', 'Use arrow keys to adjust the fit'] } };
  // 展平:steps[i] 带 course 索引;换课时重建场景。按难度挑课,开课时重建
  var steps = [], lessons = [], level = 3;
  function buildPlan(lv) {
    level = PLAN[lv] ? lv : 3;
    var plan = PLAN[level];
    steps = []; lessons = [];
    plan.courses.forEach(function (ci) {
      courses[ci].steps.forEach(function (st) {
        if (plan.skip[st.tag]) return;
        st.course = ci; steps.push(st); lessons.push(st.lesson);
      });
    });
    courses[4].steps.forEach(function (st) { if (st.tag === 'glow') st.lesson.hint = level <= 2 ? GLOW_HINTS.auto : GLOW_HINTS.card; });
    GUIDE.course = HELP.course = plan.courses[plan.courses.length - 1];
    steps.push(GUIDE); lessons.push(GUIDE.lesson);
    steps.push(HELP); lessons.push(HELP.lesson);
    FINAL.course = plan.courses[plan.courses.length - 1];
    FINAL.lesson.hint = FINALS[level].hint;
    FINAL.lesson.actions = FINALS[level].actions;
    steps.push(FINAL); lessons.push(FINAL.lesson);
  }
  buildPlan(3);
  var course = -1; // 当前已加载场景的课
  function at(tag) { return idx >= 0 && steps[idx].tag === tag; }

  // 镜头跟着飞过去的零件走(和正式装配一二级一样),落点那一侧取特写
  function followTo(nodes) {
    if (!window.KBFocus || !KBFocus.viewOf) return;
    var v = KBFocus.viewOf(nodes);
    KB.flyCamera(v.p, v.t);
  }
  function find(name) {
    var f = null;
    KB.objectsRoot.traverse(function (n) { if (!f && KB.isPart(n) && n.name === name) f = n; });
    return f;
  }

  function light(nodes) {
    unlight();
    nodes.forEach(function (n) { if (n) { KB.highlight(n, HL); lit.push(n); } });
  }
  function unlight() {
    lit.forEach(function (n) { KB.highlight(n, null); });
    lit = [];
  }
  // 高亮零件呼吸脉动
  (function pulse() {
    requestAnimationFrame(pulse);
    if (!lit.length) return;
    var k = KB.reducedMotion ? 0.55 : 0.35 + 0.35 * (0.5 + 0.5 * Math.sin(performance.now() / 260));
    lit.forEach(function (n) {
      n.traverse(function (o) { if (o.isMesh && o.material && o.material.emissive) o.material.emissiveIntensity = k; });
    });
  })();

  function renderDemo() {
    stageEl.classList.remove('tt-story'); delete stageEl.dataset.chapter;
    var lesson = lessons[idx];
    var mode = lesson.demo;
    el.dataset.demo = mode;
    // Camera lessons demonstrate the actual mouse gesture in an isolated SVG.
    var course = courses[steps[idx].course], demoBox = el.querySelector('.tt-demo');
    if (at('areas')) {
      KBTutorialPreview.stop();
      if (demoBox) demoBox.hidden = false;
      stageEl.innerHTML = '<div class="tt-area-demo"><svg viewBox="0 0 320 150" role="img" aria-label="Press B to switch the camera between the parts tray and assembly workspace">' +
        '<rect x="18" y="18" width="122" height="82" rx="10" fill="#21364d" stroke="#729bc1"/>' +
        '<rect x="180" y="18" width="122" height="82" rx="10" fill="#183e39" stroke="#78baa4"/>' +
        '<text x="79" y="43" text-anchor="middle" fill="#b9d5f3" font-size="11">PARTS TRAY</text>' +
        '<text x="241" y="43" text-anchor="middle" fill="#ade2c9" font-size="11">WORKSPACE</text>' +
        '<path d="M36 57H122 M36 70H122 M36 83H122 M207 58H275 M207 70H275 M207 82H275 M219 52V90 M231 52V90 M243 52V90 M255 52V90 M267 52V90" stroke="#93bbce" stroke-opacity=".25" fill="none"/>' +
        '<path d="M147 59H173 M151 55L147 59L151 63 M169 55L173 59L169 63" stroke="#c2d4e9" fill="none"/>' +
        '<g class="tt-area-camera"><rect x="176" y="14" width="130" height="90" rx="12" fill="#9ce8c1" fill-opacity=".07" stroke="#efbf78" stroke-width="2"/>' +
        '<rect x="230" y="77" width="17" height="12" rx="3" fill="#efbf78"/><path d="M248 81L255 78V89L248 86Z" fill="#efbf78"/></g>' +
        '<g class="tt-area-key"><rect x="143" y="112" width="34" height="28" rx="6" fill="#263a51" stroke="#efbf78"/>' +
        '<text x="160" y="131" text-anchor="middle" fill="#fff1d8" font-size="16" font-weight="600">B</text></g>' +
        '<text x="130" y="130" text-anchor="end" fill="#bcd0e7" font-size="10">PRESS</text>' +
        '<text x="188" y="130" fill="#bcd0e7" font-size="10">SWITCH VIEW</text></svg></div>';
      inputsEl.innerHTML = '<div><strong>Press B to switch areas</strong><small>Or click Parts tray / Workspace in the toolbar. Only the view moves.</small></div>';
      return;
    }
    var navigation = /^(orbit|pan|zoom)$/.test(steps[idx].tag);
    if (navigation) {
      KBTutorialPreview.stop();
      if (demoBox) demoBox.hidden = false;
      var gesture = steps[idx].tag;
      var instruction = gesture === 'orbit' ? 'Hold LEFT · drag on empty space · release' :
        gesture === 'pan' ? 'Hold RIGHT · drag sideways · release' : 'Roll forward to zoom in · roll back to zoom out';
      stageEl.innerHTML = '<div class="tt-nav tt-nav-' + gesture + '"><svg viewBox="0 0 320 150" role="img" aria-label="' + instruction + '">' +
        '<defs><pattern id="ttNavGrid" width="24" height="24" patternUnits="userSpaceOnUse"><path d="M24 0H0V24" fill="none" stroke="#91b9dd" stroke-opacity=".12"/></pattern></defs>' +
        '<rect width="320" height="150" fill="url(#ttNavGrid)"/>' +
        '<path d="M70 92 Q160 18 250 92" fill="none" stroke="#7dbbff" stroke-opacity=".5" stroke-dasharray="4 6" class="tt-nav-arc"/>' +
        '<path d="M65 80H255 M72 74L65 80L72 86 M248 74L255 80L248 86" fill="none" stroke="#7dbbff" stroke-opacity=".5" class="tt-nav-line"/>' +
        '<g class="tt-nav-hand"><rect x="137" y="40" width="46" height="68" rx="22" fill="#17293f" stroke="#bdd9f7" stroke-width="2"/>' +
        '<path class="tt-nav-left" d="M159 42C146 42 139 51 139 62V69H159Z" fill="#7dbbff"/>' +
        '<path class="tt-nav-right" d="M161 42C174 42 181 51 181 62V69H161Z" fill="#7dbbff"/>' +
        '<path d="M160 41V70 M138 70H182" stroke="#bdd9f7" fill="none"/>' +
        '<rect x="157" y="50" width="6" height="14" rx="3" fill="#e9f4ff" class="tt-nav-wheel"/>' +
        '<path class="tt-nav-wheel-arrows" d="M190 62V42 M186 46L190 42L194 46 M198 51V71 M194 67L198 71L202 67" stroke="#e9bd76" fill="none"/>' +
        '</g><text x="160" y="138" text-anchor="middle" fill="#bcd0e7" font-size="11">' +
        (gesture === 'zoom' ? 'SCROLL FORWARD  /  BACK' : gesture === 'pan' ? 'RIGHT BUTTON  +  DRAG' : 'LEFT BUTTON  +  DRAG') + '</text></svg></div>';
      inputsEl.innerHTML = '<div><strong>' + lesson.label + '</strong><small>' + instruction + '</small></div>';
      return;
    }
    if (course.preview) {
      if (demoBox) demoBox.hidden = false;
      KBTutorialPreview.show(stageEl, {
        tag: steps[idx].previewTag || steps[idx].tag || 'complete', course: steps[idx].course,
        label: lesson.label, objects: course.scene(),
        source: course.preview.source, target: course.preview.target
      });
      KBTutorialPreview.pause(el.classList.contains('minimized'));
    } else {
      KBTutorialPreview.stop();
      stageEl.innerHTML = '';
      if (demoBox) demoBox.hidden = true;
    }
    inputsEl.innerHTML = mode === 'adjust' ?
      '<div class="tt-keyboard ' + (at('turn') ? 'tt-turn-keys' : 'tt-slide-keys') + '" aria-hidden="true"><kbd class="tt-key-up">↑</kbd><div><kbd class="tt-key-left">←</kbd><kbd class="tt-key-down">↓</kbd><kbd class="tt-key-right">→</kbd></div></div><div><strong>' + lesson.label + '</strong><small>' + (at('turn') ? 'Turn the arm around its hole' : 'Slide the screw along its axis') + '</small></div>' :
      mode === 'complete' ? '<span class="tt-finish-icon">✓</span><div><strong>' + lesson.label + '</strong><small>Esc · deselect &nbsp; Ctrl / ⌘ Z · undo</small></div>' :
      '<div class="tt-mouse" aria-hidden="true"><i></i><b></b></div><div><strong>' + lesson.label + '</strong><small>Left mouse button · one click at a time</small></div>';
  }

  var TURN_GOAL = 10;      // turn:至少转这么多度
  var SLIDE_GOAL_MM = 0.5; // slide:至少滑这么多毫米(一次按 0.25 mm)
  function slidMm() {
    if (!flags.slideBase || !parts || !parts.screw) return flags.slide ? SLIDE_GOAL_MM : 0;
    var mm = 1000 / (window.KBParts ? KBParts.unitScale() : 24.77);
    return flags.slideBase.distanceTo(parts.screw.position) * mm;
  }
  function turnedDeg() {
    var byKey = Math.abs(flags.turned || 0);
    if (!flags.turnBase || !parts || !parts.arm) return byKey;
    var dot = Math.min(1, Math.abs(flags.turnBase.dot(parts.arm.quaternion)));
    return Math.max(byKey, THREE.MathUtils.radToDeg(2 * Math.acos(dot)));
  }

  function updateActions() {
    var selected = currentSelection.length === 1 ? currentSelection[0] : null;
    var armed = window.KBMate && KBMate.armed();
    var checks = [];
    var mated = function (a, b) { return !!flags.mate && flags.mate[0] === a && flags.mate[1] === b; };
    if (at('orbit')) checks = [(flags.orbited || 0) > 3 || (flags.orbitDrags || 0) > 0, (flags.orbitDrags || 0) >= ORBIT_DRAGS];
    if (at('pan')) checks = [(flags.panDrags || 0) > 0, (flags.panDrags || 0) >= PAN_DRAGS];
    if (at('zoom')) checks = [(flags.zooms || 0) > 0, (flags.zooms || 0) >= ZOOMS];
    if (at('areas')) checks = [(flags.areaCount || 0) > 0, (flags.areaCount || 0) >= AREA_HOPS];
    if (at('select')) checks = [selected === parts.arm, selected === parts.arm];
    if (at('move')) checks = [selected === parts.arm || flags.placed === parts.arm, flags.placed === parts.arm];
    if (at('mateArm')) checks = [!!armed && armed.node === parts.arm && armed.end === -1 || mated(parts.arm, parts.plate), mated(parts.arm, parts.plate)];
    if (at('turn')) checks = [turnedDeg() > 0.5, turnedDeg() >= TURN_GOAL];
    if (at('armScrew')) checks = [selected === parts.screw || !!armed && armed.node === parts.screw, !!armed && armed.node === parts.screw];
    if (at('mateScrew')) checks = [!!armed && armed.node === parts.screw || mated(parts.screw, parts.wedge), mated(parts.screw, parts.wedge)];
    if (at('slide')) checks = [slidMm() > 0.01, slidMm() >= SLIDE_GOAL_MM];
    // 后来加的几课:每一项做到了就当场打勾,不等整课结束
    var picked = function (n) { return flags.selected === n || selected === n; };
    if (at('glow')) checks = [true, picked(parts.screw)];
    if (at('suggest')) checks = [true, flags.viewTip === 'used'];
    if (at('pickScrew')) checks = [picked(parts.screw), picked(parts.screw)];
    if (at('clickScrew')) checks = [!!flags.flying || mated(parts.screw, parts.wedge), mated(parts.screw, parts.wedge)];
    if (at('clickArm')) checks = [!!flags.flying || mated(parts.arm, parts.plate), mated(parts.arm, parts.plate)];
    if (at('pickArm')) checks = [picked(parts.arm)];
    if (at('armArm')) checks = [!!armed && armed.node === parts.arm];
    if (at('mateArm2')) checks = [mated(parts.arm, parts.plate)];
    if (at('guide')) checks = [!!flags.guideFolded, !!flags.guideOpened];
    if (at('help')) checks = [!!flags.help, !!flags.help];
    // 本步已完成:全部打勾
    if (idx >= 0 && idx < steps.length - 1 && steps[idx].done()) checks = checks.map(function () { return true; });
    var current = checks.indexOf(false);
    if (current < 0) current = checks.length;
    Array.prototype.forEach.call(actionsEl.children, function (item, n) {
      item.classList.toggle('checked', !!checks[n]);
      item.classList.toggle('current', n === current && idx < steps.length - 1);
      item.querySelector('span').textContent = checks[n] ? '✓' : n + 1;
    });
  }

  function loadCourse(ci) {
    course = ci;
    var c = courses[ci];
    parts = null; // 换场景期间 onChange 看不到旧零件,别把教程当成"零件被删了"而结束
    KB.setSelection([]);
    var scene = c.scene();
    if (window.KBWorkspace) scene.forEach(function (o) { o.p[0] += KBWorkspace.center.x; });
    KB.loadSceneData({ objects: scene }, true);
    KB.pushSnapshot();
    parts = {};
    Object.keys(c.names).forEach(function (k) { parts[k] = find(c.names[k]); });
    var v = c.view || VIEW;
    var vp = v.p.slice(), vt = v.t.slice();
    if (window.KBWorkspace) { vp[0] += KBWorkspace.center.x; vt[0] += KBWorkspace.center.x; }
    KB.flyCamera(vp, vt);
    dropIn(Object.keys(parts).map(function (k) { return parts[k]; }));
  }
  // 零件依次从空中落到桌面
  function dropIn(nodes) {
    introTimers.forEach(function (intro) { clearTimeout(intro.timer); });
    introTimers = [];
    nodes.forEach(function (n, i) {
      var rest = n.position.clone();
      if (KB.reducedMotion) return;
      n.position.y += 2.2;
      n.updateMatrixWorld(true);
      var intro = { node: n, rest: rest, pending: true };
      intro.timer = setTimeout(function () { intro.pending = false; KB.tween(n, rest, n.quaternion, { duration: 0.55 }); }, 250 + i * 160);
      introTimers.push(intro);
    });
  }

  function show(i) {
    clearTimeout(advanceTimer);
    var loaded = steps[i].course !== course;
    if (loaded) loadCourse(steps[i].course);
    clearTimeout(errTimer);
    statusEl.classList.remove('err');
    statusEl.classList.remove('warn');
    advancing = false;
    textEl.classList.remove('ok');
    idx = i;
    flags = {};
    var s = steps[i];
    if (s.tag === 'turn' && parts && parts.arm) flags.turnBase = parts.arm.quaternion.clone();
    if (s.tag === 'slide' && parts && parts.screw) flags.slideBase = parts.screw.position.clone();
    stepEl.textContent = 'Lesson ' + (PLAN[level].courses.indexOf(steps[i].course) + 1) + ' \u00b7 ' + (i + 1) + ' / ' + steps.length;
    textEl.textContent = lessons[i].title;
    hintEl.textContent = lessons[i].hint;
    renderDemo();
    actionsEl.innerHTML = lessons[i].actions.map(function (action, n) {
      return '<li><span>' + (n + 1) + '</span><div>' + action + '</div></li>';
    }).join('');
    updateActions();
    statusEl.textContent = i === steps.length - 1 ? Object.keys(completed).length + ' / ' + (steps.length - 1) + ' steps practiced'
      : courses[steps[i].course].name + ' \u00b7 your turn';
    el.querySelector('.tt-bar').setAttribute('aria-valuenow', i + 1);
    var last = i === steps.length - 1;
    // 从 ARISTOS 欢迎页进来的已经答过"第一次",最后一屏只留"开始装配";单独打开教程时照旧问一句
    if (choiceEl) choiceEl.hidden = !last || onboarding;
    el.classList.toggle('finale', last);   // 收尾这屏铺满仿真窗口
    nextBtn.style.display = last && !onboarding ? 'none' : '';   // CSS 给按钮设了 display,hidden 属性压不住
    nextBtn.textContent = last ? (onboarding ? 'Start assembly →' : 'Finish ✓') : 'Skip step →';
    nextBtn.classList.toggle('primary', last && onboarding);   // 收尾这屏它是唯一的出口,做成主按钮
    barEl.style.width = ((i + 1) / steps.length * 100) + '%';
    el.classList.toggle('done', i === steps.length - 1);
    // 文字滑入
    bodyEl.classList.remove('in');
    void bodyEl.offsetWidth;
    bodyEl.classList.add('in');
    light(s.light());
    var hb = document.getElementById('btnHelp');
    if (hb) hb.classList.toggle('nudge', s.tag === 'help');          // 教 Help 那一屏,按钮闪起来
    if (s === FINAL && window.KBHelp && KBHelp.isOpen()) KBHelp.close();
    // 练习课里左上角的指引卡片跟着判每一小步;教指引那一屏再讲它是什么
    guideErr = null;
    refreshGuide();
    if (window.KBGuide && KBGuide.demo) {
      if (s.tag === 'guide') { flags.guideOpened = false; flags.guideFolded = false; }
      var ng = document.getElementById('nextGuide');
      if (ng) ng.classList.toggle('ng-teach', s.tag === 'guide');   // 这一屏让卡片闪起来
    }
    // 刚换课时零件还在从空中落下:等落定了再亮 / 出推荐视角,不然卡片会对着半空取景
    clearTimeout(demoTimer);
    if (window.KBFocus && KBFocus.demo) {
      KBFocus.demo(null);
      if (s.focus) demoTimer = setTimeout(function () { if (idx === i) KBFocus.demo(s.focus()); }, loaded && !KB.reducedMotion ? 1300 : 0);
    }
    applyExpect(s.expect ? s.expect() : null);
    if (s.view) KB.flyCamera(s.view.p, s.view.t);
  }

  /* ---------- 要点的孔口聚光;点错了拒绝并说明该点哪个 ---------- */
  // 不提 H1 / P1 这类编号(general 模式看不到):只说"哪个零件上的哪一面的亮圈"
  function describe(x) {
    var side = x.end === -1 ? 'lower ' : x.end === 1 ? 'top ' : '';
    return 'the ' + side + 'glowing disc on the ' + x.node.name;
  }
  function describeAny(x) {
    var side = x.end === -1 ? 'lower ' : x.end === 1 ? 'top ' : '';
    return 'the ' + side + 'disc on the ' + x.node.name;
  }
  function matches(x, i) { return x.node === i.node && x.id === i.id && (x.end === undefined || x.end === i.end); }
  function applyExpect(exp) {
    if (!window.KBMate) return;
    if (!exp) { KBMate.spotlight([]); KBMate.setGuard(null); return; }
    KBMate.spotlight(exp.source.concat(exp.target));
    KBMate.setGuard({
      arm: function (i) {
        if (exp.source.some(function (x) { return matches(x, i); })) return true;
        // 已经拿着正确的源,再点别的孔口 → 也拒绝(不换源)
        return 'Not that one. Click ' + exp.source.map(describe).join(' or ') + '.';
      },
      mate: function (src, dst) {
        if (!exp.target.length) return 'Not yet \u2014 first ' + lessons[idx].actions[0].toLowerCase() + '.';
        if (!exp.source.some(function (x) { return matches(x, src); })) {
          return 'Wrong source. Start again from ' + exp.source.map(describe).join(' or ') + '.';
        }
        if (exp.target.some(function (x) { return matches(x, dst); })) return true;
        return 'Wrong hole \u2014 that is ' + describeAny(dst) + '. Click ' + exp.target.map(describe).join(' or ') + '.';
      }
    });
  }
  KB.on('mateRejected', function (r) {
    if (idx < 0) return;
    guideError(r.reason);
    statusEl.textContent = r.reason;
    statusEl.classList.add('err');
    clearTimeout(errTimer);
    errTimer = setTimeout(function () { if (idx >= 0 && !advancing) { statusEl.classList.remove('err'); statusEl.textContent = 'Your turn \u00b7 try it in the scene'; } }, 4000);
  });
  var errTimer = 0, demoTimer = 0, guideShown = false, guideErr = null, guideErrTimer = 0;
  /* 练习课(插螺丝 / 机臂装前板)里,左上角的指引卡片逐条判每一小步:
     还没做 "To do",正在做 "Now",做对了当场变绿 "✓ Done";点错变红说原因;全做完 "Step complete"。
     和正式装配里同一张卡片,教人认得它是干什么的 */
  var PRACTICE = { 1: 1, 2: 1, 3: 1, 5: 1 };
  function refreshGuide() {
    if (!window.KBGuide || !KBGuide.demo || idx < 0) return;
    var s = steps[idx], ci = s.course;
    if (!PRACTICE[ci] || s === FINAL) { if (guideShown) { KBGuide.demo(null); guideShown = false; } return; }
    var rows = [];
    steps.forEach(function (st, i) { if (st.course === ci && st !== FINAL && st !== GUIDE && st !== HELP) rows.push({ st: st, i: i }); });
    var all = rows.every(function (r) { return completed[r.i]; });
    KBGuide.demo({
      name: courses[ci].name,
      parts: rows.map(function (r, n) {
        return { name: (n + 1) + ' \u00b7 ' + r.st.lesson.label, ok: !!completed[r.i], now: !completed[r.i] && r.i === idx,
                 status: completed[r.i] ? '\u2713 Done' : r.i === idx ? 'Now' : 'To do' };
      }),
      state: guideErr ? 'error' : all ? 'success' : 'progress',
      message: guideErr || (all ? 'Correct \u2014 every click checked. Step complete.' : 'Your move \u2014 this card checks each click.')
    });
    if (!guideShown) { KBGuide.setOpen(true); guideShown = true; }
  }
  // 点错了:卡片变红说原因,几秒后恢复
  function guideError(msg) {
    if (!guideShown) return;
    guideErr = msg; refreshGuide();
    clearTimeout(guideErrTimer);
    guideErrTimer = setTimeout(function () { guideErr = null; refreshGuide(); }, 3500);
  }

  var advancing = false;
  var experience = null;   // 'first' / 'again':最后一屏问出来的
  function tick() {
    if (idx < 0 || advancing) return;
    updateActions();
    if (steps[idx].status && !statusEl.classList.contains('err')) {
      var st = steps[idx].status();
      statusEl.textContent = st || 'Your turn \u00b7 try it in the scene';
      statusEl.classList.toggle('warn', !!st);
    }
    if (!steps[idx].done()) return;
    advancing = true;
    updateActions();
    textEl.classList.add('ok');
    completed[idx] = true;
    guideErr = null; refreshGuide();                  // 这一小步当场在卡片上打勾
    statusEl.textContent = 'Nice work! Moving to the next step…';
    var at = idx;
    advanceTimer = setTimeout(function () {
      advancing = false;
      textEl.classList.remove('ok');
      if (idx === at && idx < steps.length - 1) show(idx + 1);
    }, /^(clickScrew|clickArm|mateScrew|mateArm2|mateArm)$/.test(steps[at].tag) ? 1800 : 700);   // 零件刚飞进去:多停一下看清
  }

  function start(opts) {
    if (!window.KBParts || !KBParts.ready()) { KB.toast('Parts library still loading…'); return; }
    stop('restart');
    if (window.KBAnswer) KBAnswer.hide();          // 常驻的逐步指引 / 虚影属于正式装配,教程期间收起来
    onboarding = !!(opts && opts.onboarding);
    buildPlan((opts && opts.level) || (window.KBLevel ? KBLevel.get() : 3));
    completed = {};
    if (KB.setExpert) KB.setExpert(false);
    course = -1;
    // 开场:相机从高处俯冲进来(show(0) 会加载第一课的零件并让它们落下)
    KB.camera.position.set(VIEW.p[0] * 2.2, VIEW.p[1] * 2.6, VIEW.p[2] * 2.2);
    KB.orbit.target.fromArray(VIEW.t);
    el.classList.remove('minimized');
    document.getElementById('ttMinimize').setAttribute('aria-expanded', 'true');
    document.getElementById('ttMinimize').setAttribute('aria-label', 'Minimize tutorial');
    document.getElementById('ttMinimize').textContent = '−';
    el.classList.add('show');
    show(0);
    clearInterval(timer);
    timer = setInterval(tick, 150);
  }

  function stop(reason) {
    var wasActive = idx >= 0;
    KBTutorialPreview.stop();
    clearTimeout(advanceTimer);
    introTimers.forEach(function (intro) {
      clearTimeout(intro.timer);
      if (intro.pending) { intro.node.position.copy(intro.rest); intro.node.updateMatrixWorld(true); }
    });
    introTimers = [];
    advancing = false;
    clearInterval(timer);
    timer = 0;
    idx = -1;
    unlight();
    applyExpect(null);
    if (window.KBFocus && KBFocus.demo) KBFocus.demo(null);
    if (wasActive && window.KBGuide && KBGuide.demo) KBGuide.demo(null);
    guideShown = false; guideErr = null;
    var ng0 = document.getElementById('nextGuide'); if (ng0) ng0.classList.remove('ng-teach');
    var hb = document.getElementById('btnHelp'); if (hb) hb.classList.remove('nudge');
    statusEl.classList.remove('err');
    el.classList.remove('show');
    if (wasActive && reason !== 'restart') KB.emit('tutorialEnd', { reason: reason === 'completed' ? 'completed' : 'skipped', experience: experience, level: level });
  }

  /* ---------- 观察 ---------- */
  KB.onSelection(function (sel) {
    currentSelection = sel.slice();
    if (idx >= 0 && sel.length === 1) flags.selected = sel[0];
    // 一级那一课:点到螺丝就让它自己飞进楔块(和正式装配里一级的"点零件就到位"一样)
    if (at('clickArm') && sel.length === 1 && sel[0] === parts.arm && !flags.flying && window.KBMate) {
      flags.flying = true;
      KBMate.mate(parts.arm, 'H1', parts.plate, 'H6', -1, 1);
      KB.setSelection([]);
      followTo([parts.plate, parts.arm]);
    }
    if (at('clickScrew') && sel.length === 1 && sel[0] === parts.screw && !flags.flying && window.KBMate) {
      flags.flying = true;
      KBMate.mate(parts.screw, 'P1', parts.wedge, 'H1', 0, 1);
      KB.setSelection([]);
      followTo([parts.wedge]);
      // 装配的提示会说"方向键微调",一级用不到 —— 换成一级的说法
    }
  });
  KB.on('help', function (h) { if (idx >= 0 && h && h.open) flags.help = true; });
  KB.on('guideOpen', function (v) {
    if (idx < 0 || !at('guide')) return;
    if (!v) flags.guideFolded = true;
    else if (flags.guideFolded) flags.guideOpened = true;          // 先收起,再打开
  });
  KB.on('viewTip', function (v) { if (idx >= 0 && v && v.used !== undefined) flags.viewTip = v.used ? 'used' : 'dismissed'; });
  KB.on('areaChange', function () { if (idx >= 0) { flags.area = true; flags.areaCount = (flags.areaCount || 0) + 1; } });
  // 相机方位角累计转了多少度 —— 第一课靠它判断"真的转过视角了"。
  // 只在用户真的按着鼠标拖的时候数:开场镜头飞行、按钮取景都不算
  (function watchOrbit() {
    var canvas = document.getElementById('viewport');
    var dragging = false, last = null, arc = 0, counted = false;
    var panning = false, panFrom = null, panCounted = false;
    var ARC_PER_DRAG = 25;    // 一次拖到这么多度才算转过一次
    var PAN_PER_DRAG = 0.8;   // 焦点挪过这么多场景单位才算平移过一次
    if (!canvas) return;
    function stop() { dragging = panning = false; last = panFrom = null; arc = 0; counted = panCounted = false; }
    canvas.addEventListener('pointerdown', function (e) {
      stop();
      // 左键转视角,右键 / 中键平移 —— 和 OrbitControls 的分工一致
      if (e.button === 2 || e.button === 1) { panning = true; panFrom = KB.orbit ? KB.orbit.target.clone() : null; }
      else if (e.button === 0) dragging = true;
    });
    window.addEventListener('pointerup', stop);
    window.addEventListener('blur', stop);
    // 滚轮:两次滚动之间隔开 400 ms 就算两次(一次滚动往往是一串 wheel 事件)
    var lastWheel = 0;
    canvas.addEventListener('wheel', function () {
      if (idx < 0) return;
      var now = performance.now();
      if (now - lastWheel > 400) flags.zooms = (flags.zooms || 0) + 1;
      lastWheel = now;
    }, { passive: true });
    setInterval(function () {
      if (idx < 0 || !KB.camera || !KB.orbit) { last = panFrom = null; return; }
      if (panning) {
        if (!panFrom) panFrom = KB.orbit.target.clone();
        else if (!panCounted && panFrom.distanceTo(KB.orbit.target) >= PAN_PER_DRAG) {
          panCounted = true;
          flags.panDrags = (flags.panDrags || 0) + 1;
        }
      }
      if (!dragging) { last = null; return; }
      var v = KB.camera.position.clone().sub(KB.orbit.target);
      var a = Math.atan2(v.z, v.x) * 180 / Math.PI;
      if (last !== null) {
        var d = Math.abs(a - last);
        if (d > 180) d = 360 - d;
        flags.orbited = (flags.orbited || 0) + d;
        arc += d;
        if (!counted && arc >= ARC_PER_DRAG) { counted = true; flags.orbitDrags = (flags.orbitDrags || 0) + 1; }
      }
      last = a;
    }, 100);
  })();
  // Registered before mate.js: observe the key before its capture handler consumes it.
  // The place event confirms that a key actually moved the tutorial screw.
  var activeArrow = null, lastShift = false;
  window.addEventListener('keydown', function (e) {
    if (!(at('turn') || at('slide')) || !/^Arrow(Up|Down|Left|Right)$/.test(e.code) || /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) || e.target.isContentEditable) return;
    activeArrow = e.code;
    lastShift = e.shiftKey;
    setTimeout(function () { activeArrow = null; }, 0);
  }, true);
  KB.on('place', function (node) {
    if (idx < 0) return;
    flags.placed = node;
    if (at('turn') && node === parts.arm && activeArrow && /Left|Right/.test(activeArrow)) {
      flags.turn = true;
      flags.turned = (flags.turned || 0) + (activeArrow === 'ArrowLeft' ? 1 : -1) * (lastShift ? 90 : 1);
    }
    if (at('slide') && node === parts.screw && activeArrow && /Up|Down/.test(activeArrow)) flags.slide = true;
  });
  KB.on('snapAttempt', function (a) {
    if (idx >= 0 && a.success) flags.mate = [a.object1, a.object2, a.snapPoint1, a.snapPoint2];
    // 装配完的提示会说"方向键微调",一级用不到:装上之后换成一级的说法(要在它之后,不然被盖掉)
    if (idx >= 0 && a.success && level <= 2) setTimeout(function () {
      KB.toast(level === 1 ? 'In it goes \u2014 on Level 1 every part lines itself up' : 'Seated \u2014 on Level 2 the part lines itself up, no keyboard needed');
    }, 0);
  });
  KB.onChange(function () {
    // 零件被删掉 / 撤销到教程之前:结束
    if (idx >= 0 && parts && Object.keys(parts).some(function (k) { return !parts[k] || !find(parts[k].name); })) stop();
  });

  document.getElementById('ttReplay').addEventListener('click', function () { if (idx >= 0) renderDemo(); });
  document.getElementById('ttMinimize').addEventListener('click', function () {
    var minimized = el.classList.toggle('minimized');
    KBTutorialPreview.pause(minimized);
    this.setAttribute('aria-expanded', String(!minimized));
    this.setAttribute('aria-label', minimized ? 'Expand tutorial' : 'Minimize tutorial');
    this.textContent = minimized ? '+' : '−';
  });
  /* 第一次装的人:关掉教程后自动弹出 Next 的逐步指引。零件库 / 场景还没就绪时多试几次 */
  function popNextGuide(tries) {
    var ready = window.KBAnswer && window.KBCheck && window.KBParts && KBParts.ready() &&
      KB.objectsRoot && KB.objectsRoot.children.length;
    if (ready) {
      // showNext() 在第一步零件还没进装配区时返回 false,但会把 ASSEMBLY GUIDE 卡片摆出来 ——
      // 那正是第一次装的人要看的,所以调一次就够,不看返回值
      KBAnswer.showNext();
      return;
    }
    if ((tries || 0) < 8) setTimeout(function () { popNextGuide((tries || 0) + 1); }, 700);
  }
  function finish(first) {
    experience = first ? 'first' : 'again';
    try { localStorage.setItem('kb.experience', experience); } catch (e) { /* 隐私模式 */ }
    var embedded = document.body.classList.contains('embed');
    stop('completed');
    if (first) {
      // 独立页面:教程的两个零件换成整套零件,再弹出逐步指引。
      // 嵌在 ARISTOS 里时场景由宿主收到 tutorialEnd 后自己装,我们只等它装完
      if (!embedded && KB.loadKit) KB.loadKit();
      setTimeout(function () { popNextGuide(0); }, embedded ? 1200 : 700);
    }
    else {
      if (window.KBLevel) KBLevel.set(3);          // 装过的人直接上三级
      KB.toast('Tutorial done \u2014 stuck at any point? Press Help at the top');
    }
  }
  var first = document.getElementById('ttFirst'), again = document.getElementById('ttAgain');
  if (first) first.addEventListener('click', function () { finish(true); });
  if (again) again.addEventListener('click', function () { finish(false); });

  nextBtn.addEventListener('click', function () {
    if (idx >= steps.length - 1) { if (onboarding) finish(true); else stop('completed'); }
    else show(Math.max(idx, 0) + 1);
  });
  // 走"第一次"流程进来的(onboarding):关掉教程 = 跳过练习、直接开始装配(和 ARISTOS 里的 Skip tutorial 一样)
  closeBtn.addEventListener('click', function () { if (onboarding && idx >= 0) finish(true); else stop(); });
  document.getElementById('btnTutorial').addEventListener('click', function () {
    if (el.classList.contains('show')) { stop(); return; }
    if (KB.objectsRoot.children.length &&
        !confirm('Start the tutorial? The current scene will be replaced (undoable).')) return;
    start();
  });

  window.KBTutorial = { start: start, stop: stop, active: function () { return idx >= 0; },
    level: function () { return level; },
    _tag: function () { return idx >= 0 ? steps[idx].tag || (steps[idx] === FINAL ? 'final' : '') : null; },
    discs: function () { return level !== 1; },   // 一级教程不放圆片:只教点零件
    _debug: function () { return { flags: flags, idx: idx, advancing: advancing, parts: Object.keys(parts || {}).map(function (k) { return k + ':' + (parts[k] && parts[k].name); }), timer: timer }; } };

  if (new URLSearchParams(location.search).has('tutorial')) {
    (function wait() { if (window.KBParts && KBParts.ready()) start(); else setTimeout(wait, 100); })();
  }
  // 独立网页的封面(site/index.html)带过来的入口:
  //   ?start=tutorial&level=N  第一次:按所选难度练习,练完自动摆零件开始装配
  //   ?start=assembly&level=N  装过的:直接摆好整套零件开始装配
  (function () {
    var q = new URLSearchParams(location.search), how = q.get('start');
    if (!how || document.body.classList.contains('embed')) return;
    var lv = +q.get('level') || 3;
    (function wait() {
      if (!(window.KBParts && KBParts.ready() && window.KBLevel)) { setTimeout(wait, 100); return; }
      KBLevel.set(lv, true);
      if (how === 'tutorial') start({ onboarding: true, level: lv });
      else if (how === 'assembly' && KB.loadKit) KB.loadKit();
    })();
  })();
})();
