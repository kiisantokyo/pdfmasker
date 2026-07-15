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

// スクショのライトボックス（クリックで全体を拡大表示）
(function () {
  var box = document.createElement('div');
  box.className = 'lightbox';
  box.innerHTML =
    '<button class="lightbox-close" aria-label="閉じる">×</button>' +
    '<img alt="">' +
    '<div class="lightbox-cap"></div>';
  document.body.appendChild(box);
  var bimg = box.querySelector('img');
  var bcap = box.querySelector('.lightbox-cap');

  function openBox(img) {
    bimg.src = img.currentSrc || img.src;
    var fig = img.closest('figure');
    var cap = fig && fig.querySelector('figcaption');
    bcap.textContent = cap ? cap.textContent.trim() : (img.alt || '');
    box.classList.add('open');
    document.body.style.overflow = 'hidden';
  }
  function closeBox() {
    box.classList.remove('open');
    document.body.style.overflow = '';
    bimg.removeAttribute('src');
  }

  document.addEventListener('click', function (e) {
    var t = e.target;
    if (!t || !t.closest) return;
    var img = t.closest('.shot img');
    var shot = img && img.closest('.shot');
    if (shot && !shot.classList.contains('missing')) {
      openBox(img);
      return;
    }
    // 背景・閉じるボタン・拡大画像自身のクリックで閉じる
    if (t === box || t === bimg || t.classList.contains('lightbox-close')) closeBox();
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') closeBox();
  });
})();
