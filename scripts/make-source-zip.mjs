// AGPL の「対応するソースコード」を配布するための ZIP を作る。
//
// なぜ必要か: 本アプリは PDF エンジンに MuPDF（AGPL-3.0）を使うため AGPL-3.0-or-later
// での提供が義務。頒布した相手にソースを提供する必要がある（AGPL §6）。GitHub である
// 必要はなく、自社サーバーからの無償ダウンロードで足りる。
//
// 中身は「ビルドに必要な一式」のみ。配布ページ(web/)は動作に不要なので除く。
// 生成物は git 追跡しない（リリース時の成果物）。
//
//   node scripts/make-source-zip.mjs [出力先ディレクトリ]
//
// 出力: pdfmasker-<version>-source.zip

import { execFileSync } from 'node:child_process'
import { readFileSync, mkdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

const outDir = resolve(process.argv[2] ?? join(root, 'release'))
mkdirSync(outDir, { recursive: true })

const name = `pdfmasker-${version}-source.zip`
const out = join(outDir, name)
const prefix = `pdfmasker-${version}/`

// git archive は追跡ファイルのみを出力するので、.gitignore 済みの docs/ や .claude/ は
// そもそも入らない。web/ は追跡されているため明示的に除外する。
execFileSync(
  'git',
  ['archive', '--format=zip', '-9', `--prefix=${prefix}`, '-o', out, 'HEAD', '.', ':(exclude)web'],
  { cwd: root, stdio: 'inherit' }
)

const kb = Math.round(statSync(out).size / 1024)
console.log(`\n${name}  (${kb} KB)\n  -> ${out}`)
