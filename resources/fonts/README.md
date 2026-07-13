# 文字入れ機能の同梱フォント

「文字入れ」機能は、ユーザーが入力した任意の日本語を PDF に**実埋め込み**します
（mupdf `addFont` = Identity CIDフォント。選択・検索可能）。mupdf WASM には CJK
フォントが含まれないため、日本語フォントをここに同梱しています。

## 同梱フォント

- **`pmtext-jp.ttf`** … **BIZ UDGothic Regular**（Morisawa）。
  - ライセンス: **SIL Open Font License 1.1**（`OFL.txt` 参照）。埋め込み・再配布ともに許諾。
  - 取得元: https://github.com/googlefonts/morisawa-biz-ud-gothic
  - 選定理由: ユニバーサルデザイン書体で帳票・書類に読みやすく、Windows 同梱の
    「BIZ UDGothic」と同一デザインのため、画面のオーバーレイ（CSSの `BIZ UDGothic`）と
    焼き込み結果の字形・メトリクスが一致する。

## 読み込みと配布

- 実行時に読み込むのは `src/main/index.ts` の `loadJpFont`。
  - パッケージ時: electron-builder の `extraResources` で `resources/fonts` →
    `fonts/` にコピーされ、`process.resourcesPath/fonts/pmtext-jp.ttf` から読み込む。
  - 開発時: リポジトリ直下の `resources/fonts/pmtext-jp.ttf` から読み込む。
  - 万一 未配置の場合のみ、開発中（Windows）は `C:/Windows/Fonts/BIZ-UDGothicR.ttc`
    にフォールバック（再配布不可・保険）。
- ライセンス表記は `THIRD-PARTY-NOTICES.md` に SIL OFL 1.1 全文を記載済み。
  `OFL.txt` も同梱される。

## 別フォントに差し替える場合

`pmtext-jp.ttf` を置き換え、`THIRD-PARTY-NOTICES.md` と本 README のライセンス表記を
更新すること（再配布可フォント：Noto Sans JP / IPAexゴシック 等）。
