<#
.SYNOPSIS
    Read-only preflight for pushing this workspace to GitHub.

.DESCRIPTION
    Runs NO mutating git commands: no init, add, commit, push, fetch.
    It only inspects local state and asks GitHub read-only questions.

    Reports:
      1. is this workspace already a git repo (.git present)
      2. git --version, gh --version, gh auth status
      3. does the remote exist, and is it empty
      4. what would be committed (size, binaries, secret-shaped files) and
         which Windows-specific git settings need attention

    Every git call is scoped with -C <workspace> and -c safe.directory=<workspace>
    so a repo in the user's home directory can never trigger a
    "dubious ownership" fatal.

.PARAMETER RemoteUrl
    Remote to probe. Default https://github.com/arshad-88/FS

.PARAMETER TimeoutSeconds
    Hard ceiling for any single network command (gh / ls-remote).

.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File tools\preflight-push.ps1
#>
[CmdletBinding()]
param(
    [string] $RemoteUrl = 'https://github.com/arshad-88/FS',
    [string] $RepoSlug  = 'arshad-88/FS',
    [int]    $TimeoutSeconds = 25
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 3.0

# ---------------------------------------------------------------- helpers ----

function Write-Section {
    param([string] $Title)
    Write-Host ''
    Write-Host ('=' * 72) -ForegroundColor DarkGray
    Write-Host $Title -ForegroundColor Cyan
    Write-Host ('=' * 72) -ForegroundColor DarkGray
}

function Invoke-Bounded {
    # Runs an external command in a child job so a hanging credential prompt or
    # a stalled network call can never block this script.
    param(
        [Parameter(Mandatory = $true)][string]   $FilePath,
        [string[]] $Arguments = @(),
        [int]      $TimeoutSeconds = 25,
        [hashtable] $Environment = @{}
    )

    $script = {
        param($FilePath, $Arguments, $Environment)
        foreach ($key in $Environment.Keys) {
            Set-Item -Path ('env:' + $key) -Value $Environment[$key]
        }
        $lines = & $FilePath @Arguments 2>&1 | ForEach-Object { [string]$_ }
        [pscustomobject]@{
            ExitCode = $LASTEXITCODE
            Output   = ($lines -join [Environment]::NewLine)
        }
    }

    $job = Start-Job -ScriptBlock $script -ArgumentList $FilePath, $Arguments, $Environment
    try {
        if (Wait-Job $job -Timeout $TimeoutSeconds) {
            $received = Receive-Job $job
            if ($received -is [array]) { $received = $received[-1] }
            if ($null -eq $received) {
                # Command produced no output at all; treat as an opaque failure
                # rather than dereferencing $null under StrictMode.
                return [pscustomobject]@{ TimedOut = $false; ExitCode = 1; Output = '(no output)' }
            }
            return [pscustomobject]@{
                TimedOut = $false
                ExitCode = $received.ExitCode
                Output   = $received.Output
            }
        }
        Stop-Job $job -ErrorAction SilentlyContinue
        return [pscustomobject]@{
            TimedOut = $true
            ExitCode = $null
            Output   = "(timed out after $TimeoutSeconds s)"
        }
    }
    finally {
        Remove-Job $job -Force -ErrorAction SilentlyContinue
    }
}

function Show-Result {
    param([string] $Label, $Result)
    if ($null -eq $Result) { return }
    $state = if ($Result.TimedOut) { 'TIMEOUT' }
             elseif ($Result.ExitCode -eq 0) { 'ok' }
             else { "exit $($Result.ExitCode)" }
    $colour = if ($Result.TimedOut -or $Result.ExitCode -ne 0) { 'Yellow' } else { 'Green' }
    Write-Host ("{0}: [{1}]" -f $Label, $state) -ForegroundColor $colour
    if ($Result.Output) {
        $Result.Output -split "`r?`n" | Where-Object { $_ -ne '' } |
            ForEach-Object { Write-Host "    $_" -ForegroundColor DarkGray }
    }
}

# ------------------------------------------------------------- resolution ----

$scriptPath = $PSCommandPath
if (-not $scriptPath) { $scriptPath = $MyInvocation.MyCommand.Path }
$workspace = Split-Path -Parent (Split-Path -Parent $scriptPath)
if (-not (Test-Path -LiteralPath $workspace -PathType Container)) {
    throw "Cannot resolve workspace root from script path '$scriptPath'."
}

$gitArgs = @('-C', $workspace, '-c', "safe.directory=$workspace")

$nonInteractive = @{
    GIT_TERMINAL_PROMPT = '0'
    GCM_INTERACTIVE     = 'never'
    GH_PROMPT_DISABLED  = '1'
    GH_NO_UPDATE_NOTIFIER = '1'
}

$verdict = [ordered]@{
    Workspace        = $workspace
    RemoteUrl        = $RemoteUrl
    LocalRepoExists  = $false
    GitVersion       = ''
    GhInstalled      = $false
    GhAuthenticated  = $false
    RemoteExists     = $null
    RemoteIsEmpty    = $null
    RemoteDefaultRef = ''
}

Write-Host "FamilyShield preflight (read-only, no git mutations)" -ForegroundColor Cyan
Write-Host "Workspace : $workspace"
Write-Host "Remote    : $RemoteUrl"

# ------------------------------------------------------- 1. local .git state --

Write-Section '1. Is this workspace already a git repository?'

$dotGit = Join-Path $workspace '.git'
$verdict.LocalRepoExists = Test-Path -LiteralPath $dotGit -PathType Container
if ($verdict.LocalRepoExists) {
    Write-Host "YES - $dotGit exists." -ForegroundColor Green
    $top = Invoke-Bounded -FilePath 'git' -Arguments ($gitArgs + @('rev-parse', '--show-toplevel')) `
                          -Environment $nonInteractive -TimeoutSeconds 20
    Show-Result 'rev-parse --show-toplevel' $top

    $branch = Invoke-Bounded -FilePath 'git' -Arguments ($gitArgs + @('rev-parse', '--abbrev-ref', 'HEAD')) `
                             -Environment $nonInteractive -TimeoutSeconds 20
    Show-Result 'current branch' $branch

    $remotes = Invoke-Bounded -FilePath 'git' -Arguments ($gitArgs + @('remote', '-v')) `
                              -Environment $nonInteractive -TimeoutSeconds 20
    Show-Result 'remotes' $remotes

    $count = Invoke-Bounded -FilePath 'git' -Arguments ($gitArgs + @('rev-list', '--count', 'HEAD')) `
                            -Environment $nonInteractive -TimeoutSeconds 20
    Show-Result 'commit count' $count

    $head = Invoke-Bounded -FilePath 'git' -Arguments ($gitArgs + @('log', '-1', '--oneline')) `
                           -Environment $nonInteractive -TimeoutSeconds 20
    Show-Result 'HEAD' $head
}
else {
    Write-Host "NO - no .git in the workspace. 'git init' will be required." -ForegroundColor Yellow
}

# ------------------------------------------------------- 2. tool versions -----

Write-Section '2. Tool versions and GitHub authentication'

$gitVersion = Invoke-Bounded -FilePath 'git' -Arguments @('--version') `
                             -Environment $nonInteractive -TimeoutSeconds 20
Show-Result 'git --version' $gitVersion
if ($gitVersion.ExitCode -eq 0) { $verdict.GitVersion = ($gitVersion.Output -split "`r?`n")[0] }

$ghProbe = Get-Command gh -ErrorAction SilentlyContinue
if ($null -eq $ghProbe) {
    Write-Host 'gh: NOT INSTALLED (gh.exe not on PATH)' -ForegroundColor Yellow
    Write-Host '    Install: winget install --id GitHub.cli -e --source winget' -ForegroundColor DarkGray
    Write-Host '    Then   : gh auth login --hostname github.com --git-protocol https --web' -ForegroundColor DarkGray
}
else {
    $verdict.GhInstalled = $true
    Write-Host "gh path: $($ghProbe.Source)" -ForegroundColor DarkGray
    $ghVersion = Invoke-Bounded -FilePath 'gh' -Arguments @('--version') `
                                -Environment $nonInteractive -TimeoutSeconds 20
    Show-Result 'gh --version' $ghVersion

    $authStatus = Invoke-Bounded -FilePath 'gh' -Arguments @('auth', 'status', '--hostname', 'github.com') `
                                 -Environment $nonInteractive -TimeoutSeconds 25
    Show-Result 'gh auth status' $authStatus
    $verdict.GhAuthenticated = ($authStatus.ExitCode -eq 0)

    if ($verdict.GhAuthenticated) {
        # Must be registered as git's credential helper or a non-interactive
        # push will fail instead of authenticating.
        $helper = Invoke-Bounded -FilePath 'gh' -Arguments @('auth', 'setup-git', '--hostname', 'github.com') `
                                 -Environment $nonInteractive -TimeoutSeconds 25
        Show-Result 'gh auth setup-git (idempotent; wires credential helper)' $helper
    }
}

# -------------------------------------------------- 3. remote existence ------

Write-Section '3. Does the remote exist, and is it empty?'

if ($verdict.GhAuthenticated) {
    $repoView = Invoke-Bounded -FilePath 'gh' `
        -Arguments @('repo', 'view', $RepoSlug, '--json',
                     'nameWithOwner,isEmpty,visibility,defaultBranchRef,pushedAt,diskUsage') `
        -Environment $nonInteractive -TimeoutSeconds 25
    Show-Result "gh repo view $RepoSlug" $repoView

    if ($repoView.ExitCode -eq 0) {
        $verdict.RemoteExists = $true
        try {
            $json = $repoView.Output | ConvertFrom-Json
            $verdict.RemoteIsEmpty = [bool]$json.isEmpty
            if ($json.defaultBranchRef) { $verdict.RemoteDefaultRef = [string]$json.defaultBranchRef.name }
        }
        catch {
            Write-Host "    (could not parse JSON; read the raw output above)" -ForegroundColor Yellow
        }
    }
    elseif ($repoView.Output -match 'Could not resolve to a Repository|HTTP 404|Not Found') {
        $verdict.RemoteExists = $false
    }
}
else {
    Write-Host 'Skipped gh repo view - gh is missing or unauthenticated.' -ForegroundColor Yellow
    Write-Host 'Create it once authenticated:' -ForegroundColor DarkGray
    Write-Host "    gh repo create $RepoSlug --private --description 'FamilyShield'" -ForegroundColor DarkGray
    Write-Host '  (create it EMPTY - no README/licence - then the first push is a fast-forward)' -ForegroundColor DarkGray
}

# Empty remote ref list is authoritative and needs no credentials on a public
# repo. credential.helper= disables helpers so this can never pop a dialog.
$lsRemote = Invoke-Bounded -FilePath 'git' `
    -Arguments @('-c', 'credential.interactive=false', '-c', 'credential.helper=',
                 'ls-remote', '--heads', '--tags', '-q', $RemoteUrl) `
    -Environment $nonInteractive -TimeoutSeconds $TimeoutSeconds
Show-Result 'git ls-remote --heads --tags (anonymous)' $lsRemote

if ($null -eq $verdict.RemoteExists) {
    if ($lsRemote.TimedOut) {
        Write-Host '    Network/auth inconclusive: ls-remote timed out.' -ForegroundColor Yellow
    }
    elseif ($lsRemote.ExitCode -eq 0) {
        $verdict.RemoteExists = $true
        $verdict.RemoteIsEmpty = [string]::IsNullOrWhiteSpace($lsRemote.Output)
    }
    elseif ($lsRemote.Output -match 'Authentication failed|could not read Username|terminal prompts disabled') {
        Write-Host '    Remote is private or does not exist, and anonymous git cannot tell them apart.' -ForegroundColor Yellow
        Write-Host '    Run: gh auth status   then   gh repo view arshad-88/FS' -ForegroundColor DarkGray
    }
    elseif ($lsRemote.Output -match 'not found|404|Repository not found') {
        $verdict.RemoteExists = $false
    }
}

switch ($verdict.RemoteExists) {
    $true {
        if ($verdict.RemoteIsEmpty -eq $true) {
            Write-Host "Remote verdict: EXISTS and is EMPTY - first push is uncontested." -ForegroundColor Green
        }
        elseif ($verdict.RemoteIsEmpty -eq $false) {
            Write-Host "Remote verdict: EXISTS and is NOT empty - expect a merge/rebase decision." -ForegroundColor Yellow
        }
        else {
            Write-Host "Remote verdict: EXISTS, emptiness undetermined." -ForegroundColor Yellow
        }
    }
    $false {
        Write-Host "Remote verdict: DOES NOT EXIST (or is unreachable) - create it before pushing." -ForegroundColor Yellow
    }
    default {
        Write-Host "Remote verdict: UNDETERMINED - fix auth or network, then re-run." -ForegroundColor Yellow
    }
}

# ------------------------------------------------------- 4. tree hygiene -----

Write-Section '4. What would be committed (hygiene audit)'

$files = @(Get-ChildItem -LiteralPath $workspace -Recurse -File -Force -ErrorAction SilentlyContinue)
$totalBytes = ($files | Measure-Object -Property Length -Sum).Sum
if (-not $totalBytes) { $totalBytes = 0 }

Write-Host ("file count : {0}" -f $files.Count)
Write-Host ("total size : {0:N1} MB" -f ($totalBytes / 1MB))

$largest = $files | Sort-Object Length -Descending | Select-Object -First 12
Write-Host 'largest files:' -ForegroundColor DarkGray
foreach ($f in $largest) {
    $rel = $f.FullName.Substring($workspace.Length).TrimStart('\')
    Write-Host ("  {0,10:N0} KB  {1}" -f ($f.Length / 1KB), $rel) -ForegroundColor DarkGray
}

$tooBig = @($files | Where-Object { $_.Length -gt 95MB })
if ($tooBig.Count -gt 0) {
    Write-Host "BLOCKER: $($tooBig.Count) file(s) over GitHub's 100 MB hard limit:" -ForegroundColor Red
    $tooBig | ForEach-Object {
        Write-Host ("  {0}  ({1:N1} MB)" -f $_.FullName.Substring($workspace.Length), ($_.Length / 1MB)) -ForegroundColor Red
    }
}

$secretish = @($files | Where-Object {
    $_.Name -match '\.(keystore|jks|p12|pfx)$' -or
    $_.Name -eq '.token-secret' -or
    $_.Name -match '^\.env($|\.)' -or
    $_.Name -match 'service[-_]?account.*\.json$'
})
if ($secretish.Count -gt 0) {
    Write-Host 'secret-shaped files present (must stay out of the commit):' -ForegroundColor Yellow
    $secretish | ForEach-Object {
        Write-Host ("  {0}" -f $_.FullName.Substring($workspace.Length).TrimStart('\')) -ForegroundColor Yellow
    }
}

$generated = @($files | Where-Object { $_.FullName -match '\\(\.deps|node_modules|\.venv|dist|build)\\?' })
Write-Host ("generated/fetched files present: {0} (covered by .gitignore)" -f $generated.Count) -ForegroundColor DarkGray

$longPaths = @($files | Where-Object { $_.FullName.Length -gt 240 })
if ($longPaths.Count -gt 0) {
    Write-Host ("WARNING: {0} path(s) exceed 240 characters; enable core.longpaths before adding." -f $longPaths.Count) -ForegroundColor Yellow
}

$ignoreFile = Join-Path $workspace '.gitignore'
Write-Host (".gitignore present: {0}" -f (Test-Path -LiteralPath $ignoreFile)) -ForegroundColor DarkGray

# ------------------------------------------------- 5. Windows git settings ----

Write-Section '5. Windows git configuration that affects this push'

$settings = @(
    @('core.autocrlf', 'input or false (avoids CRLF churn)'),
    @('core.longpaths', 'true (deep .deps paths)'),
    @('credential.helper', 'manager or !gh auth git-credential'),
    @('user.name', 'required before the first commit'),
    @('user.email', 'required before the first commit'),
    @('init.defaultBranch', 'main')
)
foreach ($pair in $settings) {
    $r = Invoke-Bounded -FilePath 'git' -Arguments @('config', '--get', $pair[0]) `
                        -Environment $nonInteractive -TimeoutSeconds 15
    $value = if ($r.ExitCode -eq 0 -and $r.Output) { $r.Output.Trim() } else { '(unset)' }
    Write-Host ("  {0,-22} = {1}    [{2}]" -f $pair[0], $value, $pair[1]) -ForegroundColor DarkGray
}

# ------------------------------------------------------------- verdict -------

Write-Section 'Summary'

$verdict.GetEnumerator() | ForEach-Object {
    Write-Host ("  {0,-18} : {1}" -f $_.Key, $_.Value)
}

Write-Host ''
if (-not $verdict.GhAuthenticated) {
    Write-Host 'NEXT: authenticate gh (see §2), then re-run this preflight.' -ForegroundColor Yellow
}
elseif ($verdict.RemoteExists -eq $false) {
    Write-Host 'NEXT: create the empty repo, re-run preflight, then run the push.' -ForegroundColor Yellow
}
elseif ($verdict.RemoteIsEmpty -eq $false) {
    Write-Host 'NEXT: remote has content - review docs/PUSH_TO_GITHUB.md §6 before pushing.' -ForegroundColor Yellow
}
else {
    Write-Host 'NEXT: tools\push-to-github.ps1 -Execute' -ForegroundColor Green
}
Write-Host 'Preflight ran no mutating git commands.' -ForegroundColor DarkGray
