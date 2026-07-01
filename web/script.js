// 究極の墨消し — 紹介ページ 補助スクリプト

// 各スクショ枠に、未配置時プレースホルダ用のラベルを付与
// （figcaption の data-ss と本文から「SS-1 メイン画面」などを生成）
document.querySelectorAll('.shot').forEach(function (shot) {
  var cap = shot.querySelector('figcaption');
  if (cap) {
    var ss = cap.getAttribute('data-ss') || '';
    var label = (ss ? ss + ' ' : '') + cap.textContent.trim();
    shot.setAttribute('data-placeholder', label);
  }
});

// フッターの年号
var y = document.getElementById('year');
if (y) {
  // ビルド時の固定値で問題ないが、表示時の年に追従させる
  y.textContent = new Date().getFullYear();
}
