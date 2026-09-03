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

function Update-CodexMcpTimeout {
    param(
        [string]$ConfigPath,
        [string]$ServerName = "claude-agents",
        [int]$TimeoutSec = 3600
    )
    if (-not (Test-Path $ConfigPath)) { return }
    $content = [System.IO.File]::ReadAllText($ConfigPath, [System.Text.Encoding]::UTF8)
    $escapedName = [regex]::Escape($ServerName)
    $headerPattern = '(?m)^\[mcp_servers\.(?:' + $escapedName + '|"' + $escapedName + '"|''' + $escapedName + ''')\]\s*$'
    $headerMatch = [regex]::Match($content, $headerPattern)
    if (-not $headerMatch.Success) {
        Write-Warning "Section for mcp_servers.$ServerName not found in $ConfigPath"
        return
    }
    $headerIndex = $headerMatch.Index
    $headerLength = $headerMatch.Length
    $afterHeader = $content.Substring($headerIndex + $headerLength)

    $nextSectionMatch = [regex]::Match($afterHeader, '(?m)^\[')
    $sectionBody = if ($nextSectionMatch.Success) {
        $afterHeader.Substring(0, $nextSectionMatch.Index)
    } else {
        $afterHeader
    }
    $remainder = if ($nextSectionMatch.Success) {
        $afterHeader.Substring($nextSectionMatch.Index)
    } else {
        ""
    }

    $timeoutPattern = '(?m)^tool_timeout_sec\s*=\s*.*$'
    if ([regex]::IsMatch($sectionBody, $timeoutPattern)) {
        $newSectionBody = [regex]::Replace($sectionBody, $timeoutPattern, "tool_timeout_sec = $TimeoutSec")
    } else {
        $nl = if ($content.Contains("`r`n")) { "`r`n" } else { "`n" }
        $newSectionBody = $nl + "tool_timeout_sec = $TimeoutSec" + $sectionBody
    }

    $newContent = $content.Substring(0, $headerIndex + $headerLength) + $newSectionBody + $remainder
    [System.IO.File]::WriteAllText($ConfigPath, $newContent, [System.Text.Encoding]::UTF8)
    Write-Host "Configured mcp_servers.$ServerName.tool_timeout_sec = $TimeoutSec in $ConfigPath"
}

Write-Host "`nRegistering MCP '$Name' in Codex..."
& $Codex mcp add $Name `
    --env CLAUDE_AGENTS_MODEL=opus `
    -- $Node $Server

$CodexHome = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $env:USERPROFILE ".codex" }
$ConfigToml = Join-Path $CodexHome "config.toml"
Update-CodexMcpTimeout -ConfigPath $ConfigToml -ServerName $Name -TimeoutSec 3600

Write-Host "`nConfigured MCP servers:"
& $Codex mcp list

Write-Host "`nDone. Open a NEW Codex session before testing the tools."
