# 高德批量跑批（配额恢复后一条命令跑完三件事）
# 用法：$env:AMAP_WS_KEY='<key>'; $env:DEEPSEEK_KEY='<key>'; pwsh -File scripts/amap-batch.ps1
$ErrorActionPreference = 'Continue'
if (-not $env:AMAP_WS_KEY) { Write-Host '缺少 AMAP_WS_KEY'; exit 2 }
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $root
$live = @('chengdu', 'beijing', 'shanghai', 'xian', 'chongqing', 'hangzhou')
$liveCn = @('成都', '北京', '上海', '西安', '重庆', '杭州')

Write-Host ''; Write-Host '=== 1) 捞剩余未核验点（6 上线城） ==='
foreach ($c in $live) {
  node scripts/repair-coords.js "data/spots/$c.json" --provider amap --rescue-only --apply 2>&1 | Select-String -Pattern '裁判|周边|已写入'
}

Write-Host ''; Write-Host '=== 2) 补跑仅剩估算点的离线城（只处理 estimate） ==='
$pending = Get-ChildItem data/spots/*.json | Where-Object { $_.Name -notlike '*.report*' -and $_.Name -notlike '*.rebuild*' } | ForEach-Object {
  $j = Get-Content $_.FullName -Raw | ConvertFrom-Json
  $n = @($j.spots | Where-Object { $_.coord_src -eq 'estimate' }).Count
  if ($n -gt 0) { [pscustomobject]@{ File = $_.Name; N = $n } }
}
foreach ($p in $pending) {
  Write-Host ('  {0}：{1} 个估算点' -f $p.File, $p.N)
  node scripts/repair-coords.js ('data/spots/' + $p.File) --provider amap --apply 2>&1 | Select-String -Pattern '已写入'
}

Write-Host ''; Write-Host '=== 3) 库重构候选池采集（6 上线城） ==='
foreach ($c in $liveCn) {
  node scripts/rebuild-library.js --collect $c 2>&1 | Select-String -Pattern '候选池|失败'
}
Write-Host ''; Write-Host '完成。产物：data/spots/*.rebuild-pool.json、*.coord-repair-report.json'
