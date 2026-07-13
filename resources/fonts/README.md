# 文字入れ機能の同梱フォント

「文字入れ」機能は、ユーザーが入力した任意の日本語を PDF に**実埋め込み**します
（mupdf `addFont` = Identity CIDフォント。選択・検索可能）。mupdf WASM には CJK
フォントが含まれないため、**再配布可能な日本語フォントをこのフォルダに置く必要が
あります**。

## 必要なファイル

- `pmtext-jp.otf`（または .ttf / .ttc）— このファイル名で配置してください。
  - パッケージ時は electron-builder の `extraResources` で
    `resources/fonts` → `fonts/` にコピーされ、実行時に
    `process.resourcesPath/fonts/pmtext-jp.otf` から読み込まれます
    （`src/main/index.ts` の `loadJpFont`）。

## フォント候補（いずれも再配布可・要ライセンス確認）

- **IPAexゴシック**（IPA Font License 1.0）
- **Noto Sans JP**（SIL Open Font License 1.1）
- **BIZ UDゴシック**（SIL OFL 1.1）

採用したフォントのライセンス全文を `THIRD-PARTY-NOTICES.md` に追記してください。

## 開発時の暫定動作

このファイルが未配置でも、開発中（`pnpm dev`, Windows のみ）は
`C:/Windows/Fonts/BIZ-UDGothicR.ttc` に自動フォールバックして動作確認できます。
この Windows 同梱フォントは**再配布不可**なので、パッケージ配布前に必ず上記の
再配布可フォントを `pmtext-jp.otf` として配置してください。
