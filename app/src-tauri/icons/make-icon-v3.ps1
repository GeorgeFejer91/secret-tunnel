Add-Type -AssemblyName System.Drawing

$S = 1024
$bmp = New-Object System.Drawing.Bitmap($S, $S, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
$g.Clear([System.Drawing.Color]::Transparent)

function C([string]$hex, [int]$a = 255) {
  $r = [Convert]::ToInt32($hex.Substring(0, 2), 16)
  $gg = [Convert]::ToInt32($hex.Substring(2, 2), 16)
  $b = [Convert]::ToInt32($hex.Substring(4, 2), 16)
  [System.Drawing.Color]::FromArgb($a, $r, $gg, $b)
}

# Bubble geometry
$cx = 492.0; $cy = 452.0; $R = 396.0; $ring = 38.0

function BubblePath([double]$radius, [double]$tipScale) {
  $p = New-Object System.Drawing.Drawing2D.GraphicsPath
  $p.FillMode = [System.Drawing.Drawing2D.FillMode]::Winding
  $p.AddEllipse([float]($cx - $radius), [float]($cy - $radius), [float]($radius * 2), [float]($radius * 2))
  $pts = New-Object System.Drawing.Drawing2D.GraphicsPath
  $angles = @(116.0, 130.0, 144.0)
  $radii = @(($radius * 0.99), ($radius * $tipScale), ($radius * 0.99))
  $poly = @()
  for ($i = 0; $i -lt 3; $i++) {
    $a = $angles[$i] * [Math]::PI / 180.0
    $poly += New-Object System.Drawing.PointF([float]($cx + $radii[$i] * [Math]::Cos($a)), [float]($cy + $radii[$i] * [Math]::Sin($a)))
  }
  $pts.AddPolygon([System.Drawing.PointF[]]$poly)
  $p.AddPath($pts, $false)
  return $p
}

# Outer ring, indigo gradient
$outer = BubblePath $R 1.32
$rect = New-Object System.Drawing.RectangleF([float]($cx - $R), [float]($cy - $R - 60), [float]($R * 2), [float]($R * 2 + 200))
$ringBrush = New-Object System.Drawing.Drawing2D.LinearGradientBrush($rect, (C "c7d2fe"), (C "312e81"), 55.0)
$blend = New-Object System.Drawing.Drawing2D.ColorBlend(4)
$blend.Colors = @((C "c7d2fe"), (C "818cf8"), (C "4f46e5"), (C "312e81"))
$blend.Positions = @(0.0, 0.42, 0.72, 1.0)
$ringBrush.InterpolationColors = $blend
$g.FillPath($ringBrush, $outer)

# Interior
$inner = BubblePath ($R - $ring) 1.18
$g.FillPath((New-Object System.Drawing.SolidBrush((C "0f1020"))), $inner)

# Everything below stays inside the bubble
$state = $g.Save()
$clip = New-Object System.Drawing.Drawing2D.GraphicsPath
$clip.AddEllipse([float]($cx - ($R - $ring)), [float]($cy - ($R - $ring)), [float](($R - $ring) * 2), [float](($R - $ring) * 2))
$g.SetClip($clip)

# Receding tunnel arches, dark at the mouth to bright at the far end
$archCx = $cx + 10.0
$floor = $cy + 300.0
$shades = @("171a2e", "1f2240", "282c52", "30346b", "3730a3", "4338ca", "4f46e5", "6366f1", "9aa5fb", "eef2ff")
$n = $shades.Count
for ($i = 0; $i -lt $n; $i++) {
  $t = $i / [double]($n - 1)
  $w = 660.0 - 560.0 * $t
  $h = 620.0 - 470.0 * $t
  $left = $archCx - $w / 2
  $top = $floor - $h - 40.0 * $t
  $path = New-Object System.Drawing.Drawing2D.GraphicsPath
  $path.AddArc([float]$left, [float]$top, [float]$w, [float]$w, 180.0, 180.0)
  $path.AddLine([float]($left + $w), [float]($top + $w / 2), [float]($left + $w), [float]($floor - 30.0 * $t))
  $path.AddLine([float]($left + $w), [float]($floor - 30.0 * $t), [float]$left, [float]($floor - 30.0 * $t))
  $path.CloseFigure()
  $g.FillPath((New-Object System.Drawing.SolidBrush((C $shades[$i]))), $path)
}

# The innermost arch is the light at the far end; no separate orb.

# The path out of the tunnel: a ribbon that tapers to the vanishing point
$vx = $archCx
$vy = $floor - 232.0
$bottom = $floor + 96.0
$road = New-Object System.Drawing.Drawing2D.GraphicsPath
$road.AddBezier(
  (New-Object System.Drawing.PointF([float]($vx - 9), [float]$vy)),
  (New-Object System.Drawing.PointF([float]($vx - 96), [float]($vy + 92))),
  (New-Object System.Drawing.PointF([float]($vx + 34), [float]($vy + 168))),
  (New-Object System.Drawing.PointF([float]($vx - 196), [float]$bottom)))
$road.AddLine([float]($vx - 196), [float]$bottom, [float]($vx + 176), [float]$bottom)
$road.AddBezier(
  (New-Object System.Drawing.PointF([float]($vx + 176), [float]$bottom)),
  (New-Object System.Drawing.PointF([float]($vx + 120), [float]($vy + 150))),
  (New-Object System.Drawing.PointF([float]($vx - 36), [float]($vy + 86))),
  (New-Object System.Drawing.PointF([float]($vx + 9), [float]$vy)))
$road.CloseFigure()
$roadBrush = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
  (New-Object System.Drawing.PointF([float]$vx, [float]$vy)),
  (New-Object System.Drawing.PointF([float]$vx, [float]$bottom)),
  (C "eef2ff"), (C "6366f1"))
$g.FillPath($roadBrush, $road)

$g.Restore($state)

# Version badge
$bx = 800.0; $by = 792.0; $br = 176.0
$badgeRect = New-Object System.Drawing.RectangleF([float]($bx - $br), [float]($by - $br), [float]($br * 2), [float]($br * 2))
$g.FillEllipse((New-Object System.Drawing.SolidBrush((C "0f1020"))), (New-Object System.Drawing.RectangleF([float]($bx - $br - 20), [float]($by - $br - 20), [float](($br + 20) * 2), [float](($br + 20) * 2))))
$badgeBrush = New-Object System.Drawing.Drawing2D.LinearGradientBrush($badgeRect, (C "6366f1"), (C "312e81"), 60.0)
$g.FillEllipse($badgeBrush, $badgeRect)
$font = New-Object System.Drawing.Font("Segoe UI", 190.0, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
$fmt = New-Object System.Drawing.StringFormat
$fmt.Alignment = [System.Drawing.StringAlignment]::Center
$fmt.LineAlignment = [System.Drawing.StringAlignment]::Center
$g.DrawString("3", $font, (New-Object System.Drawing.SolidBrush((C "ffffff"))), (New-Object System.Drawing.PointF([float]$bx, [float]($by - 6))), $fmt)

$out = $args[0]
$bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bmp.Dispose()
Write-Output "wrote $out"
