/* 装配区 —— 只剩坐标, 没有画面
 *
 * 派生自 ca69f1e 的 src/workspace.js。mini 只需要 bounds / center 这两个
 * 数(整机摆在哪儿, 和主台子一致), 所以砍掉了:
 *   - 绿色边框线和 "ASSEMBLY WORKSPACE / Move the base here before
 *     connecting parts" 那张画布贴图 —— 那是给学员的指令, mini 不说话
 *   - look() / trayView() / toggle() / overview() 和 B 键、#btnArea 的绑定
 *     —— mini 的镜头由 mini.js 按当前步骤算, 没有区域切换
 *   - contains() / destination() / canConnect() / message() —— 没有判定, 没有拖动
 * ============================================================ */
(function () {
  'use strict';
  // 与 bowei 原版同一组数:托盘占 x -6.8..6.8 / z -4.2..4.2, 装配区在它前方(+z)
  var bounds = { minX: -5, maxX: 5, minZ: 6, maxZ: 16 };
  var center = new THREE.Vector3(0, 0, 11);

  window.KBWorkspace = { bounds: bounds, center: center };
})();
