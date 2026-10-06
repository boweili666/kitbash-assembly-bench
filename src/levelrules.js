/* ============================================================
 * 每一级怎么处理点孔配合 —— 一张表。每一级两个键都必须写明, 没有默认值。
 *
 *   seatCorrect  点对了(levelMateTarget 认这一对, 而且是当前这一步):
 *     reference        按答案位姿落座 —— 二级原来那条路(levelMateTarget 的位姿 + fly + markLevelPlaced)
 *     geometry         交给 mate.js 的几何配合: 只对齐孔轴, 绕轴转多少是零件原来躺着的样子
 *   wrongMate    点错了(levelMateTarget 不认, 或者认了但那是后面步骤的一对):
 *     refuse           零件不动, 说原因
 *     seat-and-report  照几何插上, 插完再判、报出来, 不撤销
 *     seat-and-undo    照几何插上, 判错就退回原位
 *
 * 一级不点孔, 但两个键照样写明(和二级同值), 免得哪天打开点孔时悄悄走了默认。
 * ============================================================ */
(function () {
  'use strict';

  var TABLE = {
    1: { seatCorrect: 'reference', wrongMate: 'refuse' },
    2: { seatCorrect: 'reference', wrongMate: 'refuse' },
    3: { seatCorrect: 'reference', wrongMate: 'seat-and-report' }
  };
  var ALLOWED = {
    seatCorrect: ['reference', 'geometry'],
    wrongMate: ['refuse', 'seat-and-report', 'seat-and-undo']
  };

  // 表写错了在加载时就炸, 而不是等到有人点孔
  Object.keys(TABLE).forEach(function (lv) {
    Object.keys(TABLE[lv]).forEach(function (k) {
      if (!ALLOWED[k]) throw new Error('level rules: level ' + lv + ' has unknown key ' + k);
    });
    Object.keys(ALLOWED).forEach(function (k) {
      if (ALLOWED[k].indexOf(TABLE[lv][k]) < 0)
        throw new Error('level rules: level ' + lv + ' ' + k + ' must be one of ' + ALLOWED[k].join(' | ') +
                        ', got ' + TABLE[lv][k]);
    });
  });

  window.KBLevelRules = {
    get: function (level, key) {
      var row = TABLE[level];
      if (!row) throw new Error('level rules: no row for level ' + level);
      if (!ALLOWED[key]) throw new Error('level rules: no key named ' + key);
      return row[key];
    }
  };
})();
