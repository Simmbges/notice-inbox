$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath (Split-Path -Parent $PSScriptRoot)
& node --env-file-if-exists=.env standalone/server.mjs
