<#
.SYNOPSIS
    Push this workspace to https://github.com/arshad-88/FS on Windows.

.DESCRIPTION
    Dry run by default: prints every git command it would run and touches nothing.
    Re-run with -Execute to actually init / add / commit / push.

    Safety properties:
      * every git call is scoped with -C <workspace> -c safe.directory=<workspace>,
        so a repo in the home directory can never cause "dubious ownership";
      * aborts if secret-shaped files (keystore, .env, server/data) would be staged;
      * aborts on any file above GitHub's 100 MB limit;
      * refuses to force-push unless -OnConflict force is given explicitly;
      * sets GIT_TERMINAL_PROMPT=0 so a missing credential can never hang the shell.

.PARAMETER RemoteUrl
    Target remote. Default https://github.com/arshad-88/FS

.PARAMETER Branch
    Branch to publish. Default main.

.PARAMETER Message
    Commit message. Default 'Initial commit: FamilyShield'.

.PARAMETER UserName / UserEmail
    Set repo-local identity if the global one is missing.

.PARAMETER OnConflict
    What to do when the remote already has commits on the target branch.
      stop   (default) abort and print the options
      merge  git fetch + merge --allow-unrelated-histories
      force  git push --force-with-lease

.PARAMETER Execute
    Actually mutate. Without it this script is read-only.

.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File tools\preflight-push.ps1
    powershell -NoProfile -ExecutionPolicy Bypass -File tools\push-to-github.ps1
    powershell -NoProfile -ExecutionPolicy Bypass -File tools\push-to-github.ps1 -Execute
#>
[CmdletBinding()]
param(
    [string] $RemoteUrl = 'https://github.com/arshad-88/FS',
    [string] $Branch    = 'main',
    [string] $Message   = 'Initial commit: FamilyShield',
    [string] $UserName  = '',
    [string] $UserEmail = '',
    [ValidateSet('stop', 'merge', 'force')]
    [string] $OnConflict = 'stop',
    [switch] $Execute,
    [int]    $TimeoutSeconds = 180
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 3.0

# ------------------------------------------------------------- resolution ----

$scriptPath = $PSCommandPath
if (-not $scriptPath) { $scriptPath = $MyInvocation.MyCommand.Path }
$workspace = Split-Path -Parent (Split-Path -Parent $scriptPath)
if (-not (Test-Path -LiteralPath $workspace -PathType Container)) {
    throw "Cannot resolve workspace root from script path '$scriptPath'."
}
Set-Location -LiteralPath $workspace

# Credential prompts would hang a CI/agent shell. Auth must come from
# `gh auth login` + `gh auth setup-git`, or Git Credential Manager already stored.
$env:GIT_TERMINAL_PROMPT = '0'
$env:GCM_INTERACTIVE     = 'never'

$mode = if ($Execute) { 'EXECUTE' } else { 'DRY RUN' }
Write-Host "FamilyShield -> $RemoteUrl  [$mode]" -ForegroundColor Cyan
Write-Host "Workspace: $workspace"

function Invoke-Git {
    param(
        [Parameter(Mandatory = $true)][string[]] $Arguments,
        [switch] $AllowFailure,
        [switch] $Network
    )

    $argv = @('-C', $workspace, '-c', "safe.directory=$workspace") + $Arguments
    Write-Host ("  git " + ($Arguments -join ' ')) -ForegroundColor DarkGray

    if (-not $Execute) {
        Write-Host '    (dry run - not executed)' -ForegroundColor DarkYellow
        return [pscustomobject]@{ ExitCode = 0; Output = ''; Skipped = $true }
    }

    if ($Network) {
        $job = Start-Job -ScriptBlock {
            param($argv, $workspace)
            $env:GIT_TERMINAL_PROMPT = '0'
            $env:GCM_INTERACTIVE = 'never'
            $lines = & git @argv 2>&1 | ForEach-Object { [string]$_ }
            [pscustomobject]@{ ExitCode = $LASTEXITCODE; Output = ($lines -join [Environment]::NewLine) }
        } -ArgumentList $argv, $workspace

        try {
            if (-not (Wait-Job $job -Timeout $TimeoutSeconds)) {
                Stop-Job $job -ErrorAction SilentlyContinue
                throw "git $($Arguments[0]) timed out after $TimeoutSeconds s"
            }
            $r = Receive-Job $job
            if ($r -is [array]) { $r = $r[-1] }
        }
        finally {
            Remove-Job $job -Force -ErrorAction SilentlyContinue
        }
    }
    else {
        $lines = & git @argv 2>&1 | ForEach-Object { [string]$_ }
        # Skipped must exist on every shape: Set-StrictMode 3.0 throws when a
        # property is read that the object does not have.
        $r = [pscustomobject]@{
            ExitCode = $LASTEXITCODE
            Output   = ($lines -join [Environment]::NewLine)
            Skipped  = $false
        }
    }

    if ($r.Output) {
        $r.Output -split "`r?`n" | Where-Object { $_ -ne '' } |
            ForEach-Object { Write-Host "    $_" -ForegroundColor DarkGray }
    }
    if ($r.ExitCode -ne 0 -and -not $AllowFailure) {
        throw "git $($Arguments -join ' ') failed with exit $($r.ExitCode)"
    }
    return $r
}

# -------------------------------------------------- 1. ignore-file guard -----

$ignorePath = Join-Path $workspace '.gitignore'
if (-not (Test-Path -LiteralPath $ignorePath)) {
    throw ".gitignore is missing. Refusing to stage the tree without it (server/data and keystore would be committed)."
}
Write-Host '.gitignore present.' -ForegroundColor Green

# ------------------------------------------------------- 2. repository --------

if (Test-Path -LiteralPath (Join-Path $workspace '.git') -PathType Container) {
    Write-Host 'Existing .git found - reusing it.' -ForegroundColor Green
}
else {
    Write-Host 'No .git - will initialise one.' -ForegroundColor Yellow
    $init = Invoke-Git -Arguments @('init', '-b', $Branch) -AllowFailure
    if (-not $Execute) { } # dry run already reported
    elseif ($init.ExitCode -ne 0) {
        # git < 2.28 has no -b
        Invoke-Git -Arguments @('init') | Out-Null
        Invoke-Git -Arguments @('symbolic-ref', 'HEAD', "refs/heads/$Branch") | Out-Null
    }
}

# Long paths must be on before adding .deps-style trees on Windows.
Invoke-Git -Arguments @('config', 'core.longpaths', 'true') | Out-Null

# ------------------------------------------------------- 3. identity ----------

$name = Invoke-Git -Arguments @('config', '--get', 'user.name')  -AllowFailure
$mail = Invoke-Git -Arguments @('config', '--get', 'user.email') -AllowFailure
$haveName = ($name.ExitCode -eq 0 -and $name.Output -and $name.Output.Trim() -ne '')
$haveMail = ($mail.ExitCode -eq 0 -and $mail.Output -and $mail.Output.Trim() -ne '')

if (-not $haveName -or -not $haveMail) {
    if ($UserName -and $UserEmail) {
        Invoke-Git -Arguments @('config', '--local', 'user.name',  $UserName)  | Out-Null
        Invoke-Git -Arguments @('config', '--local', 'user.email', $UserEmail) | Out-Null
        Write-Host "Set repo-local identity: $UserName <$UserEmail>" -ForegroundColor Green
    }
    else {
        throw "git has no user.name/user.email. Re-run with -UserName 'Your Name' -UserEmail 'you@example.com'"
    }
}

# ------------------------------------------------- 4. stage and pre-checks ----

Write-Host 'Staging everything not ignored...' -ForegroundColor Cyan
Invoke-Git -Arguments @('add', '--all') | Out-Null

if ($Execute) {
    $staged = Invoke-Git -Arguments @('diff', '--cached', '--name-only')
    $stagedPaths = @($staged.Output -split "`r?`n" | Where-Object { $_ -ne '' })

    $forbidden = @($stagedPaths | Where-Object {
        $_ -match '^server/data/' -or
        $_ -match '^keystore/' -or
        $_ -match '(^|/)\.env($|\.)' -and $_ -notmatch '\.env\.example$' -or
        $_ -match '\.(keystore|jks|p12|pfx)$' -or
        $_ -match '(^|/)\.token-secret$' -or
        $_ -match 'service[-_]?account.*\.json$' -or
        $_ -match '^(\.deps|node_modules|\.venv)/' -or
        $_ -match '^Microsoft/'
    })

    if ($forbidden.Count -gt 0) {
        Write-Host 'BLOCKER - these paths would be committed and must not be:' -ForegroundColor Red
        $forbidden | ForEach-Object { Write-Host "  $_" -ForegroundColor Red }
        throw 'Aborting before commit. Fix .gitignore (or unstage with git reset) and re-run.'
    }

    $oversize = @()
    foreach ($path in $stagedPaths) {
        $full = Join-Path $workspace $path
        if (Test-Path -LiteralPath $full) {
            $len = (Get-Item -LiteralPath $full).Length
            if ($len -gt 95MB) { $oversize += "$path ($([math]::Round($len / 1MB, 1)) MB)" }
        }
    }
    if ($oversize.Count -gt 0) {
        Write-Host 'BLOCKER - files over the 95 MB safety threshold:' -ForegroundColor Red
        $oversize | ForEach-Object { Write-Host "  $_" -ForegroundColor Red }
        throw 'Aborting before commit. Use .gitignore or Git LFS for these.'
    }

    Write-Host ("Staged {0} files, no secrets or oversized blobs detected." -f $stagedPaths.Count) -ForegroundColor Green
}

# ------------------------------------------------------------- 5. commit -----

$pending = Invoke-Git -Arguments @('status', '--porcelain') -AllowFailure
if ($Execute) {
    if ([string]::IsNullOrWhiteSpace($pending.Output)) {
        Write-Host 'Nothing to commit (working tree already clean).' -ForegroundColor Yellow
    }
    else {
        Invoke-Git -Arguments @('commit', '-m', $Message) | Out-Null
        Write-Host 'Committed.' -ForegroundColor Green
    }
}

# ------------------------------------------------------------- 6. remote -----

$existingRemote = Invoke-Git -Arguments @('remote', 'get-url', 'origin') -AllowFailure
if ($Execute -and $existingRemote.ExitCode -eq 0) {
    $current = $existingRemote.Output.Trim()
    if ($current -ne $RemoteUrl) {
        Write-Host "Repointing origin: $current -> $RemoteUrl" -ForegroundColor Yellow
        Invoke-Git -Arguments @('remote', 'set-url', 'origin', $RemoteUrl) | Out-Null
    }
}
elseif (-not ($Execute -and $existingRemote.ExitCode -eq 0)) {
    Invoke-Git -Arguments @('remote', 'add', 'origin', $RemoteUrl) -AllowFailure | Out-Null
}

# ------------------------------------------- 7. does origin/main already exist?

$lsHeads = Invoke-Git -Arguments @('ls-remote', '--heads', 'origin') -AllowFailure -Network
$remoteHasBranch = $false
if ($Execute -and -not $lsHeads.Skipped -and $lsHeads.ExitCode -eq 0) {
    $remoteHasBranch = ($lsHeads.Output -match "refs/heads/$([regex]::Escape($Branch))\b")
}
elseif ($Execute) {
    Write-Host 'Could not list remote heads (auth or network). Push will report the real error.' -ForegroundColor Yellow
}

if ($Execute -and $remoteHasBranch) {
    Write-Host "origin/$Branch already exists." -ForegroundColor Yellow
    switch ($OnConflict) {
        'stop' {
            throw @" 
Remote branch '$Branch' already has commits. Choose one:
  - keep remote history : git -C "$workspace" fetch origin; git -C "$workspace" rebase origin/$Branch
  - keep local tree     : re-run with -OnConflict force   (pushes --force-with-lease)
  - keep both           : re-run with -OnConflict merge
"@
        }
        'merge' {
            Invoke-Git -Arguments @('fetch', 'origin') -Network | Out-Null
            Invoke-Git -Arguments @('merge', '--allow-unrelated-histories', '--no-edit', "origin/$Branch") -AllowFailure | Out-Null
        }
        'force' {
            Write-Host 'Force mode selected: --force-with-lease.' -ForegroundColor Yellow
        }
    }
}

# --------------------------------------------------------------- 8. push -----

$pushArgs = @('push', '--set-upstream', 'origin', "HEAD:refs/heads/$Branch")
if ($OnConflict -eq 'force' -and $remoteHasBranch) { $pushArgs = @('push', '--force-with-lease', '--set-upstream', 'origin', "HEAD:refs/heads/$Branch") }

Write-Host 'Pushing...' -ForegroundColor Cyan
$push = Invoke-Git -Arguments $pushArgs -AllowFailure -Network

if ($Execute) {
    if ($push.ExitCode -eq 0) {
        Write-Host ''
        Write-Host "Pushed to $RemoteUrl (branch $Branch)." -ForegroundColor Green
        Invoke-Git -Arguments @('log', '--oneline', '-1') -AllowFailure | Out-Null
    }
    else {
        Write-Host ''
        Write-Host 'Push failed. Most common Windows causes:' -ForegroundColor Red
        Write-Host '  * no credentials  -> gh auth login; gh auth setup-git' -ForegroundColor DarkGray
        Write-Host '  * repo missing    -> gh repo create arshad-88/FS --private' -ForegroundColor DarkGray
        Write-Host '  * home repo error -> always use -C <workspace> (this script does)' -ForegroundColor DarkGray
        throw "git push exited $($push.ExitCode)"
    }
}
else {
    Write-Host ''
    Write-Host 'Dry run complete. Nothing was created or sent.' -ForegroundColor Green
    Write-Host 'Re-run with -Execute to perform the steps above.' -ForegroundColor Green
}
