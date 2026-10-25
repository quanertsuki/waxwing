param(
    [string]$Branch = "waxwing-0.1.0",
    [string]$Message = "Initial Waxwing 0.1.0 release"
)

$ErrorActionPreference = "Stop"

$root = (git rev-parse --show-toplevel).Trim()
if (-not $root) {
    throw "Run this script inside a Git checkout."
}

Set-Location -LiteralPath $root

$indexPath = Join-Path ([System.IO.Path]::GetTempPath()) (
    "waxwing-orphan-" + [guid]::NewGuid().ToString("N") + ".index"
)
$previousIndex = $env:GIT_INDEX_FILE

try {
    $env:GIT_INDEX_FILE = $indexPath
    git read-tree --empty
    if ($LASTEXITCODE -ne 0) {
        throw "Failed to initialize the temporary Git index."
    }

    git add -A
    if ($LASTEXITCODE -ne 0) {
        throw "Failed to stage the release snapshot."
    }

    $tree = (git write-tree).Trim()
    if ($LASTEXITCODE -ne 0 -or -not $tree) {
        throw "Failed to write the release tree."
    }

    $commit = (git commit-tree $tree -m $Message).Trim()
    if ($LASTEXITCODE -ne 0 -or -not $commit) {
        throw "Failed to create the release commit."
    }

    git update-ref "refs/heads/$Branch" $commit
    if ($LASTEXITCODE -ne 0) {
        throw "Failed to create branch $Branch."
    }

    $fileCount = (git ls-tree -r --name-only $commit |
        Measure-Object).Count
    Write-Output "Created orphan branch: $Branch"
    Write-Output "Commit: $commit"
    Write-Output "Files: $fileCount"
} finally {
    if ($null -eq $previousIndex) {
        Remove-Item Env:GIT_INDEX_FILE -ErrorAction SilentlyContinue
    } else {
        $env:GIT_INDEX_FILE = $previousIndex
    }
    Remove-Item -LiteralPath $indexPath -Force -ErrorAction SilentlyContinue
}
