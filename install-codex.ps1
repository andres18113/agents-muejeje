param(
    [string]$Name = "claude-agents"
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$Server = Join-Path $Root "src\index.mjs"

Write-Host "Checking prerequisites..."
$Node = (Get-Command node -ErrorAction Stop).Source
$null = Get-Command codex -ErrorAction Stop
$null = Get-Command claude -ErrorAction Stop

if (-not (Test-Path (Join-Path $Root "node_modules"))) {
    throw "node_modules not found. Run: npm install @modelcontextprotocol/server zod"
}

Write-Host "Node:   $Node"
Write-Host "Server: $Server"

Write-Host "`nRegistering MCP '$Name' in Codex..."
& codex mcp add $Name `
    --env CLAUDE_AGENTS_MODEL=opus `
    -- $Node $Server

Write-Host "`nConfigured MCP servers:"
& codex mcp list

Write-Host "`nDone. Open a NEW Codex session before testing the tools."
