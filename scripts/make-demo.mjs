// One-off generator for a fictional demo PDF (for the redaction app demo video).
// HTML -> Electron printToPDF (per page size/orientation) -> merge with mupdf.
// Run: electron scripts/make-demo.mjs   (ELECTRON_RUN_AS_NODE must be unset)
import { app, BrowserWindow } from 'electron'
import { writeFileSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import * as mupdf from 'mupdf'

const OUT = resolve('demo', 'デモ用サンプル.pdf')

const CSS = (w, h) => `
  @page { size: ${w}mm ${h}mm; margin: 0; }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body {
    font-family: "Yu Gothic", "Hiragino Kaku Gothic Pro", "Meiryo", sans-serif;
    color: #1f2430; font-size: 11px; line-height: 1.6; -webkit-print-color-adjust: exact;
  }
  .page { width: ${w}mm; height: ${h}mm; padding: 15mm 16mm; position: relative; overflow: hidden; }
  .wm { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
        font-size: 90px; font-weight: 800; color: rgba(200, 60, 60, 0.07);
        transform: rotate(-28deg); letter-spacing: 12px; pointer-events: none; }
  .doc-head { display: flex; justify-content: space-between; align-items: baseline;
        border-bottom: 2px solid #3b5ba5; padding-bottom: 6px; margin-bottom: 14px; }
  .doc-head .docno { color: #6b7280; font-size: 10px; }
  .secret { color: #b03030; font-weight: 700; border: 1px solid #d9a3a3; background:#fbeeee;
        padding: 1px 8px; border-radius: 4px; font-size: 10px; }
  h1 { font-size: 20px; color: #1f2937; margin: 0 0 6px; }
  h2 { font-size: 14px; color: #3b5ba5; border-left: 4px solid #3b5ba5; padding-left: 8px; margin: 16px 0 8px; }
  table { width: 100%; border-collapse: collapse; font-size: 10.5px; }
  th, td { border: 1px solid #c7ccd6; padding: 5px 7px; text-align: left; vertical-align: top; }
  th { background: #eef2fb; color: #2b3a67; font-weight: 700; }
  .num { text-align: right; font-variant-numeric: tabular-nums; }
  .muted { color: #6b7280; }
  .right { text-align: right; }
  .center { text-align: center; }
  .footer { position: absolute; left: 16mm; right: 16mm; bottom: 9mm; display:flex; justify-content:space-between;
        color:#9aa1ad; font-size:9px; border-top:1px solid #e5e7eb; padding-top:4px; }
  .kv td:first-child { background:#f6f8fc; color:#41506f; width: 26%; font-weight:600; }
  .big-amount { font-size: 16px; font-weight: 800; color:#1f2937; }
  .note { background:#f7f8fa; border:1px solid #e3e6ec; border-radius:6px; padding:8px 10px; color:#444; font-size:10px; }
`

const footer = (n) =>
  `<div class="footer"><span>コスモ商事株式会社 — 業務委託プロジェクト</span><span>${n} / 7</span></div>`

const head = (no) =>
  `<div class="doc-head"><span class="docno">文書番号: ${no}</span><span class="secret">社外秘 / 取扱注意</span></div>`

function wrap(w, h, body) {
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><style>${CSS(w, h)}</style></head><body><div class="page"><div class="wm">社外秘</div>${body}</div></body></html>`
}

// ---- Page bodies (all data is FICTIONAL) -------------------------------

const p1 = wrap(210, 297, `
  ${head('CS-2026-DOC-001')}
  <div style="margin-top:40mm; text-align:center;">
    <div class="muted" style="letter-spacing:6px;">CONFIDENTIAL</div>
    <h1 style="font-size:30px; margin:14px 0;">業務委託プロジェクト<br>関係資料一式</h1>
    <div style="font-size:14px; color:#3b5ba5; margin-top:8px;">コスモ商事株式会社</div>
  </div>
  <table class="kv" style="margin-top:40mm; width:70%; margin-left:auto; margin-right:auto;">
    <tr><td>作成日</td><td>2026年6月15日</td></tr>
    <tr><td>作成部署</td><td>経営企画部</td></tr>
    <tr><td>作成者</td><td>佐藤 花子（さとう はなこ）</td></tr>
    <tr><td>承認者</td><td>代表取締役 大野 茂</td></tr>
    <tr><td>管理番号</td><td>PJ-2026-0042</td></tr>
  </table>
  <div class="note" style="margin-top:18mm;">本資料には個人情報・取引情報が含まれます。社外への持ち出し・複製を禁止します。</div>
  ${footer(1)}
`)

const p2 = wrap(210, 297, `
  ${head('CS-2026-DOC-002')}
  <h1>関係者 連絡先一覧</h1>
  <table>
    <tr><th>氏名</th><th>フリガナ</th><th>所属・役職</th><th>電話</th><th>携帯</th><th>メール</th><th>住所</th></tr>
    <tr><td>山田 太郎</td><td>ヤマダ タロウ</td><td>コスモ商事 開発部 部長</td><td>03-1234-5678</td><td>090-1234-5678</td><td>yamada.taro@cosmo-shoji.example.jp</td><td>東京都千代田区丸の内1-2-3 コスモビル8F</td></tr>
    <tr><td>佐藤 花子</td><td>サトウ ハナコ</td><td>コスモ商事 経営企画部</td><td>03-1234-5679</td><td>080-2345-6789</td><td>sato.hanako@cosmo-shoji.example.jp</td><td>東京都港区赤坂4-5-6</td></tr>
    <tr><td>田中 美咲</td><td>タナカ ミサキ</td><td>コスモ商事 法務部</td><td>03-1234-5680</td><td>070-3456-7890</td><td>tanaka.misaki@cosmo-shoji.example.jp</td><td>東京都新宿区西新宿7-8-9</td></tr>
    <tr><td>鈴木 一郎</td><td>スズキ イチロウ</td><td>株式会社サンプルソフト 代表取締役</td><td>06-1111-2222</td><td>090-8888-7777</td><td>suzuki@samplesoft.example.jp</td><td>大阪府大阪市北区梅田1-1-1</td></tr>
    <tr><td>高橋 健</td><td>タカハシ ケン</td><td>サンプルソフト 開発リーダー</td><td>06-1111-2223</td><td>090-5555-6666</td><td>takahashi.ken@samplesoft.example.jp</td><td>大阪府大阪市中央区本町2-2-2</td></tr>
    <tr><td>渡辺 直樹</td><td>ワタナベ ナオキ</td><td>サンプルソフト 営業</td><td>06-1111-2224</td><td>080-4444-3333</td><td>watanabe@samplesoft.example.jp</td><td>大阪府吹田市江坂町3-3-3</td></tr>
  </table>
  <h2>緊急連絡網（社員番号）</h2>
  <table>
    <tr><th>社員番号</th><th>氏名</th><th>内線</th><th>備考</th></tr>
    <tr><td>EMP-100245</td><td>山田 太郎</td><td>2101</td><td>PJ責任者</td></tr>
    <tr><td>EMP-100871</td><td>佐藤 花子</td><td>3050</td><td>経理・精算担当</td></tr>
    <tr><td>EMP-101333</td><td>田中 美咲</td><td>4012</td><td>契約レビュー</td></tr>
  </table>
  ${footer(2)}
`)

const p3 = wrap(364, 257, `
  ${head('CS-2026-DOC-003')}
  <h1>報酬・精算一覧表（2026年度上期）</h1>
  <table>
    <tr><th>No</th><th>氏名</th><th>所属会社</th><th>銀行</th><th>支店</th><th>口座種別</th><th>口座番号</th><th class="num">支払金額</th><th>支払日</th><th>備考</th></tr>
    <tr><td>1</td><td>鈴木 一郎</td><td>株式会社サンプルソフト</td><td>みらい銀行</td><td>丸の内支店</td><td>普通</td><td>7654321</td><td class="num">¥1,320,000</td><td>2026-04-30</td><td>4月分 委託料</td></tr>
    <tr><td>2</td><td>高橋 健</td><td>株式会社サンプルソフト</td><td>みらい銀行</td><td>梅田支店</td><td>普通</td><td>2233445</td><td class="num">¥880,000</td><td>2026-04-30</td><td>開発リーダー</td></tr>
    <tr><td>3</td><td>渡辺 直樹</td><td>株式会社サンプルソフト</td><td>さくら信用金庫</td><td>吹田支店</td><td>普通</td><td>5566778</td><td class="num">¥440,000</td><td>2026-04-30</td><td>営業支援</td></tr>
    <tr><td>4</td><td>鈴木 一郎</td><td>株式会社サンプルソフト</td><td>みらい銀行</td><td>丸の内支店</td><td>普通</td><td>7654321</td><td class="num">¥1,320,000</td><td>2026-05-31</td><td>5月分 委託料</td></tr>
    <tr><td>5</td><td>高橋 健</td><td>株式会社サンプルソフト</td><td>みらい銀行</td><td>梅田支店</td><td>普通</td><td>2233445</td><td class="num">¥880,000</td><td>2026-05-31</td><td>開発リーダー</td></tr>
    <tr><td>6</td><td>大野 茂</td><td>コスモ商事株式会社</td><td>みらい銀行</td><td>丸の内支店</td><td>普通</td><td>1000234</td><td class="num">¥0</td><td>—</td><td>社内・支払対象外</td></tr>
    <tr><td>7</td><td>林 由香</td><td>フリーランス</td><td>ねっと銀行</td><td>第一支店</td><td>普通</td><td>9012345</td><td class="num">¥352,000</td><td>2026-05-31</td><td>デザイン外注</td></tr>
    <tr><td>8</td><td>渡辺 直樹</td><td>株式会社サンプルソフト</td><td>さくら信用金庫</td><td>吹田支店</td><td>普通</td><td>5566778</td><td class="num">¥440,000</td><td>2026-05-31</td><td>営業支援</td></tr>
    <tr><td>9</td><td>高橋 健</td><td>株式会社サンプルソフト</td><td>みらい銀行</td><td>梅田支店</td><td>普通</td><td>2233445</td><td class="num">¥550,000</td><td>2026-06-30</td><td>追加開発分</td></tr>
    <tr><th colspan="7" class="right">合計</th><th class="num">¥6,182,000</th><th colspan="2"></th></tr>
  </table>
  <div class="note" style="margin-top:10px;">※ 口座番号・支払金額は社外秘。精算担当：佐藤 花子（経営企画部）。</div>
  ${footer(3)}
`)

const p4 = wrap(210, 297, `
  ${head('CS-2026-DOC-004')}
  <h1>業務委託契約書（抜粋）</h1>
  <table class="kv">
    <tr><td>契約番号</td><td>C-2026-0042</td></tr>
    <tr><td>甲</td><td>コスモ商事株式会社（東京都千代田区丸の内1-2-3）　代表取締役 大野 茂</td></tr>
    <tr><td>乙</td><td>株式会社サンプルソフト（大阪府大阪市北区梅田1-1-1）　代表取締役 鈴木 一郎</td></tr>
    <tr><td>契約期間</td><td>2026年4月1日 〜 2026年9月30日</td></tr>
    <tr><td>委託料</td><td><span class="big-amount">金 3,300,000 円</span>（消費税込）</td></tr>
  </table>
  <h2>第1条（目的）</h2>
  <div>甲は、本プロジェクトに関するソフトウェア開発業務を乙に委託し、乙はこれを受託する。</div>
  <h2>第2条（委託料および支払）</h2>
  <div>委託料は金3,300,000円（消費税込）とし、毎月末締め翌月末払いとする。甲は乙の指定する口座（みらい銀行 丸の内支店 普通 7654321）へ振り込むものとする。</div>
  <h2>第3条（再委託）</h2>
  <div>乙は、甲の事前の書面による承諾を得た場合に限り、業務の一部を第三者（例：高橋 健、渡辺 直樹）に再委託できる。</div>
  <h2>第4条（秘密保持）</h2>
  <div>両当事者は、本契約に関して知り得た個人情報および営業秘密を、相手方の事前承諾なく第三者に開示してはならない。</div>
  <h2>第5条（解約）</h2>
  <div>当事者の一方が本契約に違反した場合、相手方は催告のうえ本契約を解除できる。連絡担当：田中 美咲（法務部）。</div>
  ${footer(4)}
`)

const p5 = wrap(297, 210, `
  ${head('CS-2026-DOC-005')}
  <h1>推進体制図 ・ 月次スケジュール</h1>
  <h2>推進体制</h2>
  <table>
    <tr><th>役割</th><th>担当者</th><th>所属</th><th>主担当業務</th></tr>
    <tr><td>プロジェクト責任者</td><td>山田 太郎</td><td>コスモ商事 開発部</td><td>全体統括・意思決定</td></tr>
    <tr><td>経理・精算</td><td>佐藤 花子</td><td>コスモ商事 経営企画部</td><td>支払・予算管理</td></tr>
    <tr><td>開発リーダー</td><td>高橋 健</td><td>サンプルソフト</td><td>設計・実装</td></tr>
    <tr><td>営業窓口</td><td>渡辺 直樹</td><td>サンプルソフト</td><td>調整・報告</td></tr>
  </table>
  <h2>月次スケジュール</h2>
  <table>
    <tr><th>工程</th><th>担当</th><th class="center">4月</th><th class="center">5月</th><th class="center">6月</th><th class="center">7月</th><th class="center">8月</th><th class="center">9月</th></tr>
    <tr><td>要件定義</td><td>山田 太郎</td><td class="center">●</td><td></td><td></td><td></td><td></td><td></td></tr>
    <tr><td>基本設計</td><td>高橋 健</td><td class="center">●</td><td class="center">●</td><td></td><td></td><td></td><td></td></tr>
    <tr><td>開発</td><td>高橋 健 / 渡辺 直樹</td><td></td><td class="center">●</td><td class="center">●</td><td class="center">●</td><td></td><td></td></tr>
    <tr><td>テスト</td><td>田中 美咲</td><td></td><td></td><td></td><td class="center">●</td><td class="center">●</td><td></td></tr>
    <tr><td>検収・納品</td><td>佐藤 花子</td><td></td><td></td><td></td><td></td><td></td><td class="center">●</td></tr>
  </table>
  ${footer(5)}
`)

const p6 = wrap(210, 297, `
  ${head('CS-2026-DOC-006')}
  <h1>打合せ議事録</h1>
  <table class="kv">
    <tr><td>日時</td><td>2026年5月20日（火）14:00〜15:30</td></tr>
    <tr><td>場所</td><td>コスモ商事 本社 会議室A</td></tr>
    <tr><td>出席者</td><td>山田 太郎、佐藤 花子、田中 美咲、鈴木 一郎、高橋 健</td></tr>
    <tr><td>作成者</td><td>佐藤 花子</td></tr>
  </table>
  <h2>議題</h2>
  <div>1. 開発進捗の確認　2. 追加開発の要否　3. 支払スケジュール</div>
  <h2>決定事項</h2>
  <table>
    <tr><th>No</th><th>内容</th><th>担当</th><th>期日</th></tr>
    <tr><td>1</td><td>追加開発（帳票機能）を <b>金 500,000 円</b> で発注</td><td>高橋 健</td><td>2026-06-30</td></tr>
    <tr><td>2</td><td>5月分委託料 1,320,000円 を月末に振込</td><td>佐藤 花子</td><td>2026-05-31</td></tr>
    <tr><td>3</td><td>契約書の秘密保持条項を再確認</td><td>田中 美咲</td><td>2026-05-27</td></tr>
  </table>
  <h2>連絡事項</h2>
  <div class="note">次回打合せ：2026年6月10日（水）14:00〜。連絡先：佐藤 花子（080-2345-6789 / sato.hanako@cosmo-shoji.example.jp）。</div>
  ${footer(6)}
`)

const p7 = wrap(210, 297, `
  ${head('CS-2026-DOC-007')}
  <h1>請求書</h1>
  <div style="display:flex; justify-content:space-between; margin-bottom:10px;">
    <div>
      <div style="font-size:13px; font-weight:700;">コスモ商事株式会社 御中</div>
      <div class="muted">東京都千代田区丸の内1-2-3</div>
      <div class="muted">ご担当：佐藤 花子 様</div>
    </div>
    <table class="kv" style="width:46%;">
      <tr><td>請求書番号</td><td>INV-2026-0156</td></tr>
      <tr><td>発行日</td><td>2026年5月31日</td></tr>
      <tr><td>支払期限</td><td>2026年6月30日</td></tr>
    </table>
  </div>
  <div class="note" style="margin-bottom:10px;">
    請求元：株式会社サンプルソフト（大阪府大阪市北区梅田1-1-1）／TEL 06-1111-2222／担当 高橋 健
  </div>
  <table>
    <tr><th>項目</th><th>数量</th><th class="num">単価</th><th class="num">金額</th></tr>
    <tr><td>業務委託費（4〜5月分）</td><td>2</td><td class="num">¥1,100,000</td><td class="num">¥2,200,000</td></tr>
    <tr><td>追加開発費（帳票機能）</td><td>1</td><td class="num">¥500,000</td><td class="num">¥500,000</td></tr>
    <tr><td class="right" colspan="3">小計</td><td class="num">¥2,700,000</td></tr>
    <tr><td class="right" colspan="3">消費税（10%）</td><td class="num">¥270,000</td></tr>
    <tr><td class="right" colspan="3"><b>合計</b></td><td class="num"><span class="big-amount">¥2,970,000</span></td></tr>
  </table>
  <h2>お振込先</h2>
  <div class="note">みらい銀行 丸の内支店 普通 7654321　カ）サンプルソフト</div>
  ${footer(7)}
`)

const SECTIONS = [
  { w: 210, h: 297, html: p1 },
  { w: 210, h: 297, html: p2 },
  { w: 364, h: 257, html: p3 },
  { w: 210, h: 297, html: p4 },
  { w: 297, h: 210, html: p5 },
  { w: 210, h: 297, html: p6 },
  { w: 210, h: 297, html: p7 }
]

async function run() {
  const win = new BrowserWindow({ show: false, webPreferences: { offscreen: true } })
  const buffers = []
  for (const s of SECTIONS) {
    await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(s.html))
    const pdf = await win.webContents.printToPDF({
      preferCSSPageSize: true,
      printBackground: true,
      pageRanges: '1',
      margins: { top: 0, bottom: 0, left: 0, right: 0 }
    })
    buffers.push(pdf)
  }
  win.destroy()

  // Merge into one PDF.
  const out = new mupdf.PDFDocument()
  for (const buf of buffers) {
    const src = new mupdf.PDFDocument(new Uint8Array(buf))
    const n = src.countPages()
    for (let i = 0; i < n; i++) out.graftPage(-1, src, i)
  }
  const bytes = out.saveToBuffer('garbage=compact').asUint8Array()
  mkdirSync(resolve('demo'), { recursive: true })
  writeFileSync(OUT, Buffer.from(bytes))

  // Report.
  const check = new mupdf.PDFDocument(Uint8Array.from(bytes))
  const count = check.countPages()
  const sizes = []
  for (let i = 0; i < count; i++) {
    const [x0, y0, x1, y1] = check.loadPage(i).getBounds()
    sizes.push(`${Math.round((x1 - x0) / 72 * 25.4)}x${Math.round((y1 - y0) / 72 * 25.4)}mm`)
  }
  console.log('WROTE', OUT)
  console.log('PAGES', count, sizes.join(', '))
}

app.whenReady().then(async () => {
  try {
    await run()
  } catch (e) {
    console.error('FAILED', e)
  } finally {
    app.quit()
  }
})
