# Generates the app icon (an ink/sumi bottle) as build/icon.png (256) and a
# multi-size build/icon.ico for electron-builder. Run on Windows:
#   powershell -ExecutionPolicy Bypass -File scripts/gen-app-icon.ps1
# Pure ASCII (the label kanji is built from a code point) so it parses under
# Windows PowerShell 5.1 regardless of file encoding.

Add-Type -AssemblyName System.Drawing
$ErrorActionPreference = 'Stop'

function New-RoundedRect([System.Drawing.RectangleF]$r, [single]$rad) {
  $p = New-Object System.Drawing.Drawing2D.GraphicsPath
  $d = $rad * 2
  $p.AddArc($r.X, $r.Y, $d, $d, 180, 90)
  $p.AddArc($r.Right - $d, $r.Y, $d, $d, 270, 90)
  $p.AddArc($r.Right - $d, $r.Bottom - $d, $d, $d, 0, 90)
  $p.AddArc($r.X, $r.Bottom - $d, $d, $d, 90, 90)
  $p.CloseFigure()
  return $p
}

function Get-IconPng([int]$S) {
  $f = [single]$S
  $bmp = New-Object System.Drawing.Bitmap($S, $S, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAlias
  $g.Clear([System.Drawing.Color]::Transparent)

  $ink = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(0x1A, 0x1A, 0x22))
  $red = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(0xC0, 0x28, 0x2D))
  $white = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::White)

  # rounded lavender background with a vertical gradient
  $bg = New-Object System.Drawing.RectangleF((0.03 * $f), (0.03 * $f), (0.94 * $f), (0.94 * $f))
  $bgPath = New-RoundedRect $bg ([single](0.22 * $f))
  $grad = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
    $bg,
    [System.Drawing.Color]::FromArgb(0xF1, 0xEC, 0xFB),
    [System.Drawing.Color]::FromArgb(0xD6, 0xC9, 0xF1),
    90.0)
  $g.FillPath($grad, $bgPath)

  # bottle body, neck, red cap
  $body = New-RoundedRect (New-Object System.Drawing.RectangleF((0.29 * $f), (0.45 * $f), (0.42 * $f), (0.40 * $f))) ([single](0.11 * $f))
  $g.FillPath($ink, $body)
  $g.FillRectangle($ink, (0.42 * $f), (0.31 * $f), (0.16 * $f), (0.18 * $f))
  $cap = New-RoundedRect (New-Object System.Drawing.RectangleF((0.385 * $f), (0.23 * $f), (0.23 * $f), (0.10 * $f))) ([single](0.03 * $f))
  $g.FillPath($red, $cap)

  # white label + sumi kanji (skip the kanji at tiny sizes to avoid mush)
  $label = New-RoundedRect (New-Object System.Drawing.RectangleF((0.34 * $f), (0.55 * $f), (0.32 * $f), (0.23 * $f))) ([single](0.035 * $f))
  $g.FillPath($white, $label)
  if ($S -ge 48) {
    $font = New-Object System.Drawing.Font('Yu Gothic UI', [single](0.18 * $f), [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
    $sf = New-Object System.Drawing.StringFormat
    $sf.Alignment = [System.Drawing.StringAlignment]::Center
    $sf.LineAlignment = [System.Drawing.StringAlignment]::Center
    $lr = New-Object System.Drawing.RectangleF((0.34 * $f), (0.545 * $f), (0.32 * $f), (0.245 * $f))
    $g.DrawString([string][char]0x58A8, $font, $ink, $lr, $sf)
    $font.Dispose()
  }

  $ms = New-Object System.IO.MemoryStream
  $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
  $bytes = $ms.ToArray()
  $g.Dispose(); $bmp.Dispose(); $ms.Dispose()
  $ink.Dispose(); $red.Dispose(); $white.Dispose(); $grad.Dispose()
  return ,$bytes
}

$outDir = Join-Path $PSScriptRoot '..\build'
if (-not (Test-Path $outDir)) { New-Item -ItemType Directory -Path $outDir | Out-Null }

# 256px PNG (also used as the runtime BrowserWindow icon)
$png256 = Get-IconPng 256
[System.IO.File]::WriteAllBytes((Join-Path $outDir 'icon.png'), $png256)

# multi-size ICO (PNG-compressed entries)
$sizes = @(16, 32, 48, 64, 128, 256)
$pngs = @{}
foreach ($s in $sizes) { $pngs[$s] = Get-IconPng $s }

$ms = New-Object System.IO.MemoryStream
$bw = New-Object System.IO.BinaryWriter($ms)
$bw.Write([uint16]0); $bw.Write([uint16]1); $bw.Write([uint16]$sizes.Count)
$offset = 6 + 16 * $sizes.Count
foreach ($s in $sizes) {
  $len = $pngs[$s].Length
  $dim = if ($s -ge 256) { 0 } else { $s }
  $bw.Write([byte]$dim); $bw.Write([byte]$dim); $bw.Write([byte]0); $bw.Write([byte]0)
  $bw.Write([uint16]1); $bw.Write([uint16]32)
  $bw.Write([uint32]$len); $bw.Write([uint32]$offset)
  $offset += $len
}
foreach ($s in $sizes) { $bw.Write($pngs[$s]) }
$bw.Flush()
[System.IO.File]::WriteAllBytes((Join-Path $outDir 'icon.ico'), $ms.ToArray())
$bw.Dispose(); $ms.Dispose()

Write-Host "wrote build/icon.png and build/icon.ico (sizes: $($sizes -join ', '))"
