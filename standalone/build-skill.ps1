$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$skillRoot = Join-Path $projectRoot 'skills/zhihui-notices'
$required = @('SKILL.md', 'agents/openai.yaml', 'references/mcp.md', 'references/timeline.md', 'references/planning.md', 'references/course-import.md', 'references/reflection.md', 'scripts/render-timeline.mjs')
$actual = @(Get-ChildItem -LiteralPath $skillRoot -File -Recurse | ForEach-Object { [IO.Path]::GetRelativePath($skillRoot, $_.FullName).Replace('\', '/') })
if (@(Compare-Object $required $actual).Length) { throw 'Skill package contents differ from the reviewed file list.' }
$releaseDirectory = Join-Path $projectRoot 'releases'
New-Item -ItemType Directory -Path $releaseDirectory -Force | Out-Null
$archive = Join-Path $PSScriptRoot 'public/zhihui-notices.zip'
Compress-Archive -LiteralPath $skillRoot -DestinationPath $archive -CompressionLevel Optimal -Force
$hash = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant()
Copy-Item -LiteralPath $archive -Destination (Join-Path $releaseDirectory 'zhihui-notices.zip') -Force
[IO.File]::WriteAllText((Join-Path $releaseDirectory 'zhihui-notices.zip.sha256'), "$hash  zhihui-notices.zip`n", [Text.UTF8Encoding]::new($false))
[pscustomobject]@{ SkillArchive = $archive; SHA256 = $hash } | ConvertTo-Json -Compress
