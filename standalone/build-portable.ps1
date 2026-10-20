param([string]$NodeVersion = '24.19.0')
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
& (Join-Path $PSScriptRoot 'build-skill.ps1')
$cache = Join-Path $projectRoot '.sites-local/portable-runtime'
$releaseDirectory = Join-Path $projectRoot 'releases'
$runtimeName = "node-v$NodeVersion-win-x64"
$runtimeZip = Join-Path $cache "$runtimeName.zip"
$checksums = Join-Path $cache "SHASUMS256-$NodeVersion.txt"
New-Item -ItemType Directory -Path $cache, $releaseDirectory -Force | Out-Null

if (-not (Test-Path -LiteralPath $checksums)) {
  Invoke-WebRequest -Uri "https://nodejs.org/dist/v$NodeVersion/SHASUMS256.txt" -OutFile $checksums
}
if (-not (Test-Path -LiteralPath $runtimeZip)) {
  Invoke-WebRequest -Uri "https://nodejs.org/dist/v$NodeVersion/$runtimeName.zip" -OutFile $runtimeZip
}
$checksumLine = Get-Content -LiteralPath $checksums | Where-Object { $_ -match "  $([regex]::Escape($runtimeName)).zip$" }
$expectedHash = ($checksumLine -split '\s+')[0]
if (-not $expectedHash -or (Get-FileHash -LiteralPath $runtimeZip -Algorithm SHA256).Hash -ne $expectedHash) {
  throw 'Node.js runtime checksum verification failed.'
}
$staging = Join-Path $projectRoot ('.sites-local/portable-build/' + [guid]::NewGuid().ToString('N'))
$runtimeDirectory = Join-Path $staging $runtimeName
Expand-Archive -LiteralPath $runtimeZip -DestinationPath $staging
$packageRoot = Join-Path $staging '知会本地版'
$applicationRoot = Join-Path $packageRoot 'app'
$bundledRuntime = Join-Path $packageRoot 'runtime'
New-Item -ItemType Directory -Path $applicationRoot, $bundledRuntime -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $runtimeDirectory 'node.exe'), (Join-Path $runtimeDirectory 'LICENSE') -Destination $bundledRuntime

# Only package runtime files: never copy databases, credentials or checkout-local state.
$applicationFiles = @(
  'app/panel.html', 'public/app.js', 'public/styles.css', 'public/desktop.css', 'public/schedule.js', 'public/schedule.css', 'public/event-rules.js', 'public/event-editor.js', 'public/event-editor.css', 'public/planner.js', 'public/planner.css',
  'lib/notice-input.ts', 'lib/notice-store.ts',
  'standalone/server.mjs', 'standalone/auth.mjs', 'standalone/database.mjs', 'standalone/mcp.mjs', 'standalone/agent-notices.mjs', 'standalone/categories.mjs', 'standalone/event-store.mjs', 'standalone/task-store.mjs', 'standalone/planner-api.mjs'
)
$applicationFiles += Get-ChildItem -LiteralPath (Join-Path $projectRoot 'standalone/public') -File | ForEach-Object { 'standalone/public/' + $_.Name }
$applicationFiles += Get-ChildItem -LiteralPath (Join-Path $projectRoot 'standalone/migrations') -Filter '*.sql' -File | ForEach-Object { 'standalone/migrations/' + $_.Name }
$applicationFiles += Get-ChildItem -LiteralPath (Join-Path $projectRoot 'drizzle') -Filter '*.sql' -File | ForEach-Object { 'drizzle/' + $_.Name }
foreach ($relativePath in $applicationFiles) {
  $target = Join-Path $applicationRoot $relativePath
  New-Item -ItemType Directory -Path (Split-Path -Parent $target) -Force | Out-Null
  Copy-Item -LiteralPath (Join-Path $projectRoot $relativePath) -Destination $target
}
$utf8 = [Text.UTF8Encoding]::new($false)
[IO.File]::WriteAllText((Join-Path $applicationRoot 'package.json'), '{"type":"module"}', $utf8)
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'portable/launcher.mjs') -Destination $packageRoot
foreach ($entry in @(@('start.cmd', '启动知会.cmd'), @('stop.cmd', '停止知会.cmd'))) {
  $text = [IO.File]::ReadAllText((Join-Path $PSScriptRoot ('portable/' + $entry[0]))) -replace '\r?\n', "`r`n"
  [IO.File]::WriteAllText((Join-Path $packageRoot $entry[1]), $text, $utf8)
}
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'portable/使用说明.txt') -Destination $packageRoot

$archive = Join-Path $releaseDirectory 'zhihui-windows-x64.zip'
Compress-Archive -LiteralPath $packageRoot -DestinationPath $archive -CompressionLevel Optimal -Force
$archiveHash = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant()
[IO.File]::WriteAllText("$archive.sha256", "$archiveHash  zhihui-windows-x64.zip`n", $utf8)
$stagingBase = [IO.Path]::GetFullPath((Join-Path $projectRoot '.sites-local/portable-build')) + [IO.Path]::DirectorySeparatorChar
$resolvedStaging = [IO.Path]::GetFullPath($staging)
if (-not $resolvedStaging.StartsWith($stagingBase, [StringComparison]::OrdinalIgnoreCase)) { throw 'Unexpected staging path.' }
Remove-Item -LiteralPath $resolvedStaging -Recurse -Force
[pscustomobject]@{ Archive = $archive; Bytes = (Get-Item -LiteralPath $archive).Length; SHA256 = $archiveHash; Node = $NodeVersion } | ConvertTo-Json -Compress
