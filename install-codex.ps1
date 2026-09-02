param(
    [string]$Name = "claude-agents"
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$Server = Join-Path $Root "src\index.mjs"

Write-Host "Checking prerequisites..."
$Node = (Get-Command node -ErrorAction Stop).Source
$Npm = (Get-Command npm.cmd -ErrorAction Stop).Source
$CodexCommand = Get-Command codex.cmd -ErrorAction SilentlyContinue
if (-not $CodexCommand) { $CodexCommand = Get-Command codex -ErrorAction Stop }
$ClaudeCommand = Get-Command claude.exe -ErrorAction SilentlyContinue
if (-not $ClaudeCommand) { $ClaudeCommand = Get-Command claude.cmd -ErrorAction SilentlyContinue }
if (-not $ClaudeCommand) { $ClaudeCommand = Get-Command claude -ErrorAction Stop }
$Codex = $CodexCommand.Source
$Claude = $ClaudeCommand.Source

$NodeVersion = (& $Node --version).Trim()
$NodeMajor = [int](($NodeVersion -replace '^v', '').Split('.')[0])
if ($NodeMajor -lt 20) {
    throw "Node.js 20 or newer is required; found $NodeVersion at $Node"
}
$NpmVersion = (& $Npm --version).Trim()
$CodexVersion = (& $Codex --version | Select-Object -First 1)
$ClaudeVersion = (& $Claude --version | Select-Object -First 1)

if (-not (Test-Path (Join-Path $Root "node_modules"))) {
    throw "node_modules not found. Run: npm.cmd ci; then run: npm.cmd run ci"
}

Write-Host "Node:   $NodeVersion ($Node)"
Write-Host "npm:    $NpmVersion ($Npm)"
Write-Host "Codex:  $CodexVersion ($Codex)"
Write-Host "Claude: $ClaudeVersion ($Claude)"
Write-Host "Server: $Server"

Write-Host "`nRegistering MCP '$Name' in Codex..."
& $Codex mcp add $Name `
    --env CLAUDE_AGENTS_MODEL=opus `
    -- $Node $Server

Write-Host "`nConfigured MCP servers:"
& $Codex mcp list

Write-Host "`nDone. Open a NEW Codex session before testing the tools."
