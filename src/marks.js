/* ============================================================
 * 着色标记 —— 台子自带的状态公告 + AI 可调的指点
 *
 * 功能① 状态公告(台子自己做, 不用 AI):
 *     已装进装配区、而且判定通过的件  → 淡黄
 *     刚刚判对的那一件                → 先淡绿闪 600 ms, 再落回淡黄
 *     还在料盘 / 判定没通过的          → 不着色(装错的由功能②的红色接管)
 *   源是 check.js 的判定结果 slots[].ok, 不是 KB.emit('place') —— 'place' 任何放下
 *   都会触发, 包括放错, 拿它闪绿等于给错误发奖。挂在已有的 KB.onChange 上, 不新增刷新周期。
 *
 * 功能② AI 指点:
 *     红 = 你弄错的那个东西, 绿 = 你该做的那个东西。零件本体着色, 或者孔口画圆片。
 *   孔的圆片是一条新通路: mate.js 的圆片只给"选中 / 已 arm"的零件建、而且只在
 *   二级以上建, 所以"标出 B 和 C 两个孔"在一级或没选中的零件上什么都不会出现。
 *   这里的圆片不接受点击、不依赖难度档、不依赖选中, 单独一组。
 *
 * 分层的颜色状态机(优先级 ai > flash > base):
 *   app.js 的 KB.highlight() 直接写 emissive, 写 null 就写黑。淡黄和 AI 的红共用
 *   那一个写口的话, 清掉红就会把淡黄一起擦掉。所以每件零件记一个状态, 由 apply()
 *   统一解析。KB.highlight() 本身不改(focus.js 还在用它), 只在它外面包一层:
 *   显式给色的照旧放行, "清掉"(color 为空)时先回落到本模块的状态, 没状态才写黑。
 * ============================================================ */
(function () {
  'use strict';

  var KB = window.KB;

  // 都刻意淡, 和台子已占的饱和色区分开:
  // focus.js 的琥珀 0xffc81e(下一步该点这件) / mate.js 的 0x5ad35a 0xd9534f 0xff2d95 0x8a4bff 0x9af2ff
  // AI 的两个标注色要"跳出来", 所以除了 emissive 还把**底色**一起染(tint):
  // 只写 emissive 的话, 浅色螺丝上一层红加光就成了粉色 —— 不是颜色不够深,
  // 是底下的白把它冲淡了。tint 给多少由 tintAmount 定, 1 = 完全盖掉原色。
  var TONE = {
    installed: { color: 0xf5e6a8, intensity: 0.22 },                    // 已装件:淡黄, 不染底色
    just_ok:   { color: 0xb8e6bd, intensity: 0.40 },                    // 刚装对:淡绿, 闪一下
    green:     { color: 0x00c853, intensity: 0.85, tint: 0x0a7a35, tintAmount: 0.9 },  // AI: 你该做的
    red:       { color: 0xff0080, intensity: 0.95, tint: 0xc4006a, tintAmount: 0.95 }  // AI: 你弄错的(品红)
  };
  var FLASH_MS = 600;

  var ENABLED = true;          // 功能①(状态着色); KBMarks.auto(false) 关掉
  var marks = {};              // uuid -> { node, base:'installed'|null, flash:<until ms>|null, ai:'red'|'green'|<css>|null }
  var wasOk = {};              // 上一轮判定通过的件, 用来收回被拆下来那些的淡黄

  function slot(node) {
    var m = marks[node.uuid];
    if (!m) { m = marks[node.uuid] = { node: node, base: null, flash: null, ai: null }; }
    return m;
  }
  function live(m) { return !!(m && (m.ai || m.base || m.flash)); }

  /* ---------- 写 emissive(+ 可选的底色) ----------
   * 底色要先存一份原值(kbMarkBase), 取消标注时还原 —— focus.js 用 kbBase 存它自己那份,
   * 两者互不覆盖。 */
  var _c = new THREE.Color();
  function paint(node, tone) {
    node.traverse(function (o) {
      if (!o.isMesh || !o.material || !o.material.emissive || o.userData.kbOverlay) return;
      var m = o.material;
      if (tone) {
        m.emissive.set(tone.color);
        m.emissiveIntensity = tone.intensity;
        if (tone.tint !== undefined) {
          if (!m.userData.kbMarkBase) m.userData.kbMarkBase = m.color.clone();
          m.color.copy(m.userData.kbMarkBase).lerp(_c.set(tone.tint), tone.tintAmount);
        } else if (m.userData.kbMarkBase) {
          m.color.copy(m.userData.kbMarkBase);
          delete m.userData.kbMarkBase;
        }
      } else {
        m.emissive.set(0x000000);
        m.emissiveIntensity = 1;
        if (m.userData.kbMarkBase) { m.color.copy(m.userData.kbMarkBase); delete m.userData.kbMarkBase; }
      }
    });
  }
  function toneOf(m) {
    if (m.ai) return TONE[m.ai] || { color: m.ai, intensity: 0.70 };   // 'red' / 'green' / 任意 CSS 色
    if (m.flash && m.flash > performance.now()) return TONE.just_ok;
    if (m.base === 'installed') return TONE.installed;
    return null;
  }
  // focus.js 指着的那一件由它每帧重写 emissive(琥珀呼吸), 优先级在淡绿之上。
  // 刚装对的件往往正是它刚才指着的那一件, 所以淡绿的 600 ms 会被琥珀整段盖掉 ——
  // 等它松手(focus 的 450 ms 去抖之后)再开始计时, 不然这一闪谁也看不见
  function focusOwns(node) {
    return !!(window.KBFocus && KBFocus.lit && KBFocus.lit().indexOf(node) >= 0);
  }
  function apply(node) {
    var m = marks[node.uuid];
    if (!m) { paint(node, null); return; }
    if (m.flash && !m.ai && focusOwns(node)) {
      m.flash = performance.now() + FLASH_MS;
      setTimeout(function () { apply(node); }, 120);
      return;
    }
    paint(node, toneOf(m));
    if (!live(m)) delete marks[node.uuid];
  }

  /* ---------- KB.highlight() 外面包一层 ----------
   * focus.js 的 restore() 调 KB.highlight(n, null) 写黑, 宿主的 highlight(id, null) 也一样。
   * 本模块有状态的件, "清掉"应当回落到淡黄 / 淡绿, 而不是变黑。
   * 显式给色的一律原样放行 —— focus.js 的琥珀、宿主的点亮色都不受影响。 */
  var rawHighlight = KB.highlight;
  KB.highlight = function (node, color) {
    if (!node) return;
    // AI 的标注压在所有东西之上: answer.js 的 Next 候选琥珀(0xe8a33d)也是走这个口,
    // 不让它盖掉的话, tutor 标的那一件会被"下一步候选"的琥珀刷成琥珀色
    var m = marks[node.uuid];
    if (m && m.ai) return apply(node);
    if (color) return rawHighlight(node, color);
    if (live(m)) return apply(node);
    return rawHighlight(node, color);
  };

  // 闪完落回淡黄。deadline 可能被 apply() 往后推(琥珀还占着), 所以到点再看一眼
  function expire(node, m) {
    setTimeout(function () {
      if (!m.flash) return;
      if (m.flash > performance.now()) { expire(node, m); return; }
      m.flash = null;
      apply(node);
    }, 120);
  }

  /* ---------- 功能①:跟着判定结果走 ---------- */
  function inWorkspace(node) { return !window.KBWorkspace || KBWorkspace.contains(node); }
  function syncInstalled() {
    if (!ENABLED) return;
    if (!(window.KBCheck && window.KBParts && KBParts.ready())) return;
    if (!KBCheck.results()) { wasOk = {}; return; }     // 场面换了: 判定清空, 重新开始
    // 这里**不催** KBCheck.evaluate() —— 见下面 KB.onChange 那一段(审计 F4)。
    // 只读 check.js 已经算好的结果; 要算的时候由调用方自己先算(KB.on('place') 就是)
    var res = KBCheck.results();
    if (!res || !res.ready) return;
    var nowOk = {}, touched = {};
    res.slots.forEach(function (t) {
      if (!t.part || !t.ok) return;
      var node = t.part.node;
      if (!inWorkspace(node)) return;                  // 料盘里的件不参与状态着色
      nowOk[node.uuid] = node;
      var m = slot(node);
      m.base = 'installed';
      touched[node.uuid] = true;
    });

    Object.keys(nowOk).forEach(function (id) {
      var node = nowOk[id], m = slot(node);
      apply(node);
      if (m.flash) expire(node, m);
    });
    // 被拆下来 / 判定失效的: 取消淡黄(AI 的标记留着, 它说的是别的事)
    Object.keys(wasOk).forEach(function (id) {
      if (touched[id]) return;
      var m = marks[id];
      if (!m) return;
      m.base = null; m.flash = null;
      apply(m.node);
    });
    wasOk = nowOk;
  }
  /* ---------- AI 标记的解除, 不靠 'place' 事件 ----------
   * 清除原先只挂在 KB.on('place') 上, 而学员把东西弄对的路子不止一条: 方向键微调、
   * check.js 的自动吸附、整组被搬动, 都可能没有一条 'place' 落在被标的那一件上。
   * 实测 2026-09-27 的会话: 台子已经报 issues:[] 且 partsOk 7→8(它知道装对了),
   * 而 tutor 标的品红一直挂着。
   *
   * 所以判据换成和 chat 折叠同一条: **没有任何 error / warn 的 issue 再指向它**。
   * 这个判定每次 KB.onChange 都跑, 与用什么手法弄对的无关。hint 不算 —— 它说的是
   * 下一步要干什么, 不是"这件错了"。
   */
  function clearSolvedMarks() {
    if (!(window.KBCheck && KBCheck.results)) return;
    var res = KBCheck.results();
    if (!res || !res.ready) return;                 // 判定还没出来, 什么都别动
    var solved = [];
    Object.keys(marks).forEach(function (id) {
      var m = marks[id];
      // 只看**品红**: 它是"你这件错了", 所以"没人再说它错"就是它的终点。
      // 绿是"你该做这个", 它指的目标本来就没有 issue —— 拿这条判它会当场清掉,
      // 那一对标注还没来得及看就消失了。绿的随品红一起走(settle 清全部)。
      if (m.ai !== 'red' || !m.node.parent) return;
      if (!inWorkspace(m.node)) return;             // 还在料盘里: tutor 说的事还没做
      if (issueOn(m.node)) return;                  // 还被判着错, 标记留着
      solved.push(m);
    });
    if (!solved.length) return;
    settle();                                       // 清掉全部 AI 标记 + 整组闪淡绿
  }

  /* ---------- 挂在 KB.onChange 上, 但**不在派发里做判定** (审计 F4) ----------
   * 口径出自 DEBUG-arrow-advance.md §4「步内不做任何检测」: 黄箭头在一步之内逐件
   * 往下指的时候, 台子不该重算判定。patch 08 已经为这条口径把料盘的钩子从
   * 「每次变化同步 evaluate()」改成「只读 results()」(tray.js:218-223 的注释),
   * 本模块原先又在 syncInstalled() 里同步调了一次 KBCheck.evaluate() —— 等于
   *   1) 把判定提前到零件刚落、位置还没稳的时刻;
   *   2) 在 change 的派发里重入 check.js 自己那套 300ms 去抖。
   *
   * 改成和料盘一模一样的两条:
   *   1) syncInstalled() / clearSolvedMarks() 只读 check.js 算好的 results();
   *   2) 晚于 check.js 的 300ms 去抖再读(520ms), 读到的才是这次变化之后的判定。
   * KB.on('place') 那一路不受影响: 它是「放下了一件」, 不是步内的微调, 而且它
   * 自己先 evaluate() 再 syncInstalled() —— 那是 F2 照抄 guide.js:135 的写法。
   */
  var settleWatch = 0;
  KB.onChange(function () {
    clearTimeout(settleWatch);
    settleWatch = setTimeout(function () {
      syncInstalled();
      clearSolvedMarks();
    }, 520);                                  // > check.js 的 300ms 去抖
  });

  /* ---------- "刚装好一件" —— 用 guide.js 的信号, 不用集合差分 ----------
   * 原先这两件事(清掉 AI 标记 / 整组闪淡绿)挂在"这一轮有槽位从 false 变 true"上,
   * 而左上角那张卡早就有同一个信号, 只用三行(guide.js:125-130): 听单个零件的
   * 'place', 450ms 后问一次 KBCheck.slotOf(node).ok。这里照抄那三行。
   *
   * 但 t.ok 一个人不够。实测(2026-09-26): Left / Right Arm Wedge 落位 450ms 后
   * KBCheck.slotOf() 还是 null —— 结构件要等它的螺丝进来才进槽位, 所以单靠 t.ok,
   * tutor 标在楔块上的红永远不掉, 正是 F2 那个现象。所以再加一条并列的信号:
   * **tutor 标着的那一件被放进了装配区** —— 它就是 tutor 让人做的那件事, 做了就算结了
   * (holes:true 在这种件上回的本来就是 {isBase:true} = "把它放进装配区")。
   *
   * 但"进了装配区"一个人也不够: 把一件标红的零件从一个错孔挪到**另一个错孔**, 它还在
   * 装配区里, 红就掉了 —— 屏幕说没事, 其实还是错的。所以再加一道闸: 判定结果里
   * **不再有任何一条问题指着这一件**。'hint' 不算问题(它说的是"接下来搬进装配区"这类
   * 下一步, 而结构件正是靠它才在没进槽位时也能结), 所以只看 error / warn。
   */
  function issueOn(o) {
    if (!(window.KBCheck && KBCheck.results)) return false;
    var res = KBCheck.results();
    if (!res || !res.ready) return false;
    return (res.issues || []).some(function (i) {
      return i.node === o && i.severity !== 'hint' && i.kind !== 'hint';
    });
  }
  function aiMarkedInside(node) {
    var hit = false;
    node.traverse(function (o) {
      if (hit || !KB.isPart(o)) return;
      var m = marks[o.uuid];
      if (m && m.ai && inWorkspace(o) && !issueOn(o)) hit = true;
    });
    return hit;
  }
  /* 先清 AI 标记和圆片(它说的那件事已经结了), 再让整个已装组件一起闪淡绿,
   * 到点全部落回淡黄。顺序不能倒: 优先级 ai > flash, 不先清就闪不出来 */
  function settle() {
    clearAi();
    var until = performance.now() + FLASH_MS, flashing = [];
    Object.keys(marks).forEach(function (id) {
      var m = marks[id];
      if (m.base !== 'installed') return;
      m.flash = until;
      flashing.push(m);
    });
    flashing.forEach(function (m) { apply(m.node); expire(m.node, m); });
  }
  KB.on('place', function (node) {
    setTimeout(function () {
      if (!ENABLED || !window.KBCheck) return;
      if (window.KBTutorial && KBTutorial.active()) return;
      var res = KBCheck.evaluate();
      if (!res || !res.ready) return;
      syncInstalled();                                 // 淡黄先铺到位, 再决定闪谁
      var t = KBCheck.slotOf(node);
      if (!(t && t.ok) && !aiMarkedInside(node)) return;
      settle();
    }, 450);
  });

  /* ---------- 功能②:孔口圆片(新通路, 不依赖难度档 / 选中) ---------- */
  var discRoot = new THREE.Group();
  discRoot.name = 'AI marks';
  discRoot.userData.kbOverlay = true;      // 抓帧时隐藏, 和别的辅助图形一样
  discRoot.renderOrder = 996;              // 低于 mate.js 的交互圆片(997 / 998)
  KB.scene.add(discRoot);
  var discGeo = new THREE.CircleGeometry(1, 32);
  var discs = [];                          // { mesh, node, f, end }

  function featureOf(key, id) {
    var spec = window.KBParts && KBParts.spec(key);
    if (!spec) return null;
    var list = id.charAt(0) === 'H' ? (spec.holes || []) : (spec.pegs || []);
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
    return null;
  }
  function addDisc(node, id, color) {
    var f = featureOf(node.userData.kbType.slice(5), id);
    if (!f) throw new Error('mark: no feature ' + id + ' on ' + node.name);
    var tone = TONE[color] || { color: color };
    var ends = id.charAt(0) === 'H' ? [1, -1] : [0];   // 孔有两个孔口, 各画一个; 销只画中段
    ends.forEach(function (end) {
      var mat = new THREE.MeshBasicMaterial({ color: tone.color, transparent: true, opacity: 0.85,
        depthTest: false, depthWrite: false, side: THREE.DoubleSide });
      var mesh = new THREE.Mesh(discGeo, mat);
      mesh.renderOrder = 996;
      mesh.userData.kbOverlay = true;
      discRoot.add(mesh);
      discs.push({ mesh: mesh, node: node, f: f, end: end, kind: id.charAt(0) === 'H' ? 'hole' : 'peg' });
    });
  }
  function clearDiscs() {
    discs.forEach(function (d) { d.mesh.material.dispose(); discRoot.remove(d.mesh); });
    discs = [];
  }
  // 圆片跟着零件走: 每帧按 mate.js 的 worldFeature() 重算世界坐标
  (function follow() {
    requestAnimationFrame(follow);
    if (!discs.length || !window.KBMate || !KBMate.worldFeature) return;
    discs.forEach(function (d) {
      if (!d.node.parent) { d.mesh.visible = false; return; }
      var w = KBMate.worldFeature({ node: d.node, f: d.f, kind: d.kind, end: d.end });
      var at = d.end ? w.mouth : w.c;
      d.mesh.visible = true;
      d.mesh.position.copy(at).addScaledVector(w.d, d.end * 0.012);
      d.mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), w.d);
      var r = Math.max(w.r * 1.35, 0.075);
      d.mesh.scale.set(r, r, 1);
    });
  })();

  /* ---------- 对外:AI 下发 / 清掉标记 ---------- */
  function clearAi() {
    clearDiscs();
    // 上一批的箭头取舍不能压住下一批
    if (window.KBFocus && KBFocus.forgetArrows) KBFocus.forgetArrows();
    // 临时指出来的那个黄箭头也是这一批标注的一部分, 一起收掉
    if (window.KBFocus && KBFocus.pointAt) KBFocus.pointAt(null);
    Object.keys(marks).slice().forEach(function (id) {
      var m = marks[id];
      if (!m.ai) return;
      m.ai = null;
      // 这一条挂过的箭头跟着它一起走: 三种颜色都可能带箭头, 收的方式一样
      if (window.KBFocus && KBFocus.markArrow) KBFocus.markArrow(m.node, false);
      apply(m.node);
    });
  }
  /* items 两种形状, 互斥:
   *   {id, point:true}                                   黄箭头, 不带 color, 不染色
   *   {id, color:'red'|'green'|<css>, feature?, holes?}   染件 / 画孔口圆片
   * clear:true 先清掉全部 AI 标记(圆片、染色、黄箭头都算) */
  /* ---------- 认名字, 不只认 uuid ----------
   * 宿主那边的 AI 点名零件用的是**人看的名字**("M3x22mm Pan Screw #3"), 不是
   * userData.kbId 那个 uuid, 而且它还会漏词(真名是 "M3x22mm Pan Head Screw #3")。
   * 所以按三层找: uuid -> 名字完全相同 -> 名字词集包含(大小写和标点都不计)。
   * 找不到的不静默丢掉: 全部收进 notFound 交回宿主, 好让 tutor 知道它点名了
   * 台子上不存在的东西(比如"Hex Driver 2.0 mm" —— 模拟器里没有工具)。
   */
  function norm(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(); }
  function tokens(s) { return norm(s).split(' ').filter(Boolean); }
  function findPart(idOrName) {
    var byId = KB.partById(idOrName);
    if (byId) return byId;
    var all = [];
    KB.objectsRoot.traverse(function (o) { if (KB.isPart(o)) all.push(o); });
    var want = norm(idOrName), exact = null;
    all.forEach(function (n) { if (!exact && norm(n.name) === want) exact = n; });
    if (exact) return exact;
    // 词集包含: 查询里每个词都出现在候选名字里; 命中多个时取名字最短的(最贴切)
    var wt = tokens(idOrName), best = null;
    if (!wt.length) return null;
    all.forEach(function (n) {
      var nt = tokens(n.name);
      var all_in = wt.every(function (w) { return nt.indexOf(w) >= 0; });
      if (!all_in) return;
      if (!best || n.name.length < best.name.length) best = n;
    });
    return best;
  }

  /* ---------- "这颗零件该进哪个孔" ----------
   * 宿主那边的 AI 不知道孔的 id, 而且**猜不出来**: 步骤描述写 "threaded hole [3] of
   * [Split Rear Plate]", 台子的答案数据里那颗螺丝配的却是 H4。所以孔号一律由台子
   * 按自己的参考装配解析 —— 宿主只说"标这颗零件的目标孔", 传 holes:true。
   */
  function destinationHoles(node) {
    if (!(window.KBCheck && KBCheck.results)) return [];
    var res = KBCheck.results();
    if (!res || !res.ready) return [];
    var mine = null;
    res.slots.forEach(function (t) { if (!mine && t.part && t.part.node === node) mine = t; });
    if (!mine) {                                   // 还没进装配区: 按名字找它的参考槽位
      res.slots.forEach(function (t) { if (!mine && t.ref && t.ref.name === node.name) mine = t; });
    }
    if (!mine || !mine.ref || !mine.ref.mates) return [];
    var out = [];
    mine.ref.mates.forEach(function (m) {
      (m.features || []).forEach(function (pair) {
        // pair = [自己的特征, 对方的特征]; 要标的是**对方**那个孔
        var theirs = pair[1];
        if (!theirs || theirs.charAt(0) !== 'H') return;
        var hostSlot = m.slot, hostNode = null;
        res.slots.forEach(function (t) { if (t.ref === hostSlot && t.part) hostNode = t.part.node; });
        if (!hostNode) return;
        out.push({ node: hostNode, feature: theirs });
      });
    });
    return out;
  }

  /* ---------- "宿主件还没上桌" 不再是一句 notFound ----------
   * 二级的引导早就答过这个问题(levels.js:193-204): 没有孔可点时, 要么这件本身就是
   * 这一步的基座(点一下直接进装配区), 要么得先放它要装上去的那一件。判断用台子
   * 自己的 KBCheck.level2Base(node), 不新造逻辑 —— 回给宿主, tutor 才说得出人话。
   */
  function deferFor(node) {
    if (!(window.KBCheck && KBCheck.level2Base)) return null;
    var b = KBCheck.level2Base(node);
    if (!b) return null;
    if (b.isBase) return { isBase: true };
    if (b.baseName) return { needsFirst: b.baseName };
    return null;
  }

  function set(items, clear) {
    if (clear) clearAi();
    var marked = [], notFound = [], deferred = [], pointed = [];
    (items || []).forEach(function (it) {
      /* ---------- 三种标记互斥, 不设优先级 (doc/0926/plan-mark-routing.md) ----------
       * `point` = 黄箭头「看这里」, 它不是零件的一种状态, 所以**没有颜色**;
       * `red` / `green` = 「这件错了」/「该装这里」, 它们必须带颜色。
       * 所以条目的合法形状是二者其一, 不是「颜色必填」——「颜色必填」正是线上把一个
       * 定位提问染成绿色的结构性原因: 想要箭头只能借一个颜色填进去。
       * 缺了就抛, 不猜(NO_FALLBACK)。 */
      /* 「指你自己在等的那件」: 不带 id, 台子来挑。问「下一个是啥」的唯一
       * 正确答法 —— 台子的阴影早就把它显示出来了, 外面该来查, 不该自己编一个
       * 名字再回头让台子去找(线上实测: 编出来的那个件台子根本不等, 回 notFound)。 */
      if (it && it.next && it.point && !it.id) {
        var w = (window.KBFocus && KBFocus.waitingFor) ? KBFocus.waitingFor() : [];
        if (!w.length) { notFound.push('(this step is waiting for nothing)'); return; }
        if (window.KBFocus.pointAt(w[0])) {
          pointed.push(w[0].name);
          if (it.arrow === false && KBFocus.markArrow) KBFocus.markArrow(w[0], false);
        } else {
          notFound.push(w[0].name + ' (the bench would not point at it)');
        }
        return;
      }
      if (!it) throw new Error('mark needs an entry');
      /* next:true 也适用于颜色 / 孔: 「这一步该往哪儿装」问的是台子在等的那一件
       * 该进哪个孔 —— 件是台子挑的, 孔也由它按参考装配解析, 外面一个名字都不用给。 */
      if (it.next && !it.id) {
        var wn = (window.KBFocus && KBFocus.waitingFor) ? KBFocus.waitingFor() : [];
        if (!wn.length) { notFound.push('(this step is waiting for nothing)'); return; }
        it = Object.assign({}, it, { id: wn[0].name });
      }
      if (!it.id) throw new Error('mark needs id: ' + JSON.stringify(it));
      if (!it.point && !it.color) throw new Error('mark needs point or color: ' + JSON.stringify(it));
      if (it.color === 'point') throw new Error('point is not a colour; send {point:true} with no colour: ' + JSON.stringify(it));
      var node = findPart(it.id);
      if (!node) { notFound.push(it.id); return; }
      /* 学员问了"下一件是哪个 / 它在哪": 复用 bowei 那套黄箭头临时指一下。
       * 指完**立刻 return** —— 原先这里不返回, 继续落到下面的 slot(node).ai = it.color,
       * 于是「指一下」同时把件染成了颜色。指点的出口只有 pointed, 不进 marked。 */
      if (it.point) {
        if (!(window.KBFocus && KBFocus.pointAt)) throw new Error('this build has no KBFocus.pointAt');
        if (KBFocus.pointAt(node)) pointed.push(node.name);
        else notFound.push(it.id + ' (not a part this step is waiting for)');
        return;
      }
      if (it.holes) {
        var dest = destinationHoles(node);
        if (!dest.length) {
          var d = deferFor(node);
          if (!d) { notFound.push(it.id + ' (no destination hole known yet)'); return; }
          d.asked = it.id; d.name = node.name;
          deferred.push(d);
          return;
        }
        dest.forEach(function (h) { addDisc(h.node, h.feature, it.color); });
        marked.push({ asked: it.id, id: node.userData.kbId || null, name: node.name,
                      color: it.color,
                      holes: dest.map(function (h) { return h.node.name + '/' + h.feature; }) });
        return;
      }
      if (it.feature) {
        // 模型自己编的孔号(日志里真出现过 feature:'3')不该把整批标注一起炸掉:
        // 收进 notFound 和名字解析失败同一口径, 剩下的照标
        try { addDisc(node, it.feature, it.color); }
        catch (e) { notFound.push(it.id + ' (' + e.message + ')'); return; }
      } else {
        slot(node).ai = it.color;
        apply(node);
      }
      // 三种颜色都有"带箭头"和"不带箭头"两种形态, 由调用方逐条指定 ——
      // 同一种颜色在不同部署里可以只染色, 也可以额外挂一个同色的箭头。
      // 没说就是不挂: 多一个箭头是多一句话, 该由发指令的一方决定。
      if (window.KBFocus && KBFocus.markArrow) KBFocus.markArrow(node, !!it.arrow);
      marked.push({ asked: it.id, id: node.userData.kbId || null, name: node.name,
                    color: it.color, arrow: !!it.arrow });
    });
    return { marked: marked, notFound: notFound, deferred: deferred, pointed: pointed };
  }

  window.KBMarks = {
    set: set,
    /* 调色:KBMarks.tone('red', {color:0xff0080, intensity:0.95, tint:0xc4006a, tintAmount:0.95}) */
    tone: function (name, spec) {
      if (spec) { TONE[name] = spec; Object.keys(marks).forEach(function (id) { apply(marks[id].node); }); }
      return TONE[name];
    },
    /* 单独查一件:宿主想先确认名字对不对时用 */
    find: function (idOrName) { var n = findPart(idOrName); return n ? { id: n.userData.kbId || null, name: n.name } : null; },
    clear: clearAi,
    /* AI 的标注在不在这一件上 —— focus.js 每帧重写 emissive, 要让它躲开 */
    aiOwns: function (node) { var k = marks[node && node.uuid]; return !!(k && k.ai); },
    /* 功能①(状态着色)的开关; 关掉时把已铺的淡黄收回 */
    auto: function (on) {
      if (on !== undefined) {
        ENABLED = !!on;
        if (!ENABLED) {
          Object.keys(marks).slice().forEach(function (id) {
            var m = marks[id];
            m.base = null; m.flash = null;
            apply(m.node);
          });
          wasOk = {};
        // 开回来时用 check.js 最近一次算好的结果铺淡黄 —— 这里也不催 evaluate()
        // (同 F4 的口径)。真的需要最新判定时, 下一次 KB.onChange 的 520ms 会补上
        } else syncInstalled();
      }
      return ENABLED;
    },
    tones: TONE,
    /* 验收用: 某件现在解析出来的色(没有则 null), 以及孔圆片的数量 */
    toneOf: function (node) { var m = node && marks[node.uuid]; var t = m && toneOf(m); return t ? t.color : null; },
    discs: function () { return discs.length; },
    state: function (node) { var m = node && marks[node.uuid]; return m ? { base: m.base, flash: !!(m.flash && m.flash > performance.now()), ai: m.ai } : null; }
  };
})();
