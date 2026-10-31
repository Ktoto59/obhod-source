$ErrorActionPreference = 'Stop'

$projectDirectory = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$package = Get-Content -Raw -Encoding UTF8 (Join-Path $projectDirectory 'package.json') | ConvertFrom-Json
$version = $package.version
$productName = $package.build.productName
$releaseDirectory = Join-Path $projectDirectory 'release'
$installer = Join-Path $releaseDirectory "Obhod-Setup-$version.exe"
$blockmap = "$installer.blockmap"
$manifest = Join-Path $releaseDirectory 'latest.yml'
$runtimeManifestPath = Join-Path $projectDirectory 'legal\runtime-components.json'
$runtimeManifest = Get-Content -Raw -Encoding UTF8 $runtimeManifestPath | ConvertFrom-Json
$gplRuntime = $runtimeManifest.components | Where-Object { $_.licenseExpression -like 'GPL*' } | Select-Object -First 1
if (-not $gplRuntime) { throw 'Bundled GPL runtime is missing from legal/runtime-components.json.' }
$runtimeSourceArchive = Join-Path $releaseDirectory $gplRuntime.releaseSourceName
$legalArchive = Join-Path $releaseDirectory "Obhod-$version-licenses.zip"
$repository = 'Ktoto59/obhod-releases'
$tag = "v$version"
$notesFile = Join-Path $projectDirectory "windows\release-notes\$version.md"
$signingKey = if ($env:OBHOD_SIGNING_KEY) {
  [System.IO.Path]::GetFullPath($env:OBHOD_SIGNING_KEY)
} else {
  Join-Path ([Environment]::GetFolderPath('UserProfile')) '.ssh\id_ed25519_github.pub'
}
$releaseCheckout = Join-Path ([System.IO.Path]::GetTempPath()) "obhod-releases-$([guid]::NewGuid().ToString('N'))"

function Invoke-CheckedCommand {
  param(
    [Parameter(Mandatory = $true)][scriptblock]$Command,
    [Parameter(Mandatory = $true)][string]$ErrorMessage
  )

  & $Command
  if ($LASTEXITCODE -ne 0) { throw $ErrorMessage }
}

Push-Location $projectDirectory
try {
  if (-not (Test-Path -LiteralPath $signingKey)) {
    throw "Signing key was not found: $signingKey"
  }

  $pendingChanges = @(git status --porcelain)
  if ($LASTEXITCODE -ne 0) { throw 'Unable to read the source repository state.' }
  if ($pendingChanges.Count -gt 0) {
    throw 'Commit all source changes before publishing a release.'
  }

  $previousErrorActionPreference = $ErrorActionPreference
  $ErrorActionPreference = 'SilentlyContinue'
  & gh release view $tag --repo $repository *> $null
  $releaseExists = $LASTEXITCODE -eq 0
  $ErrorActionPreference = $previousErrorActionPreference
  if ($releaseExists) { throw "Release $tag already exists." }

  Invoke-CheckedCommand { npm test } 'Tests failed.'
  Invoke-CheckedCommand { npm run build:installer } 'Installer build failed.'

  Invoke-WebRequest -UseBasicParsing -Uri $gplRuntime.sourceArchiveUrl -OutFile $runtimeSourceArchive
  if ((Get-Item -LiteralPath $runtimeSourceArchive).Length -lt 102400) {
    throw 'Downloaded GPL corresponding-source archive is unexpectedly small.'
  }
  Compress-Archive -Force -Path @(
    (Join-Path $projectDirectory 'LICENSE'),
    (Join-Path $projectDirectory 'NOTICE'),
    (Join-Path $projectDirectory 'LICENSES'),
    (Join-Path $projectDirectory 'THIRD_PARTY_NOTICES.md'),
    (Join-Path $projectDirectory 'legal'),
    (Join-Path $projectDirectory 'windows\docs\BUILDING_RUNTIME.md'),
    (Join-Path $projectDirectory 'docs\LICENSING.md')
  ) -DestinationPath $legalArchive

  foreach ($file in @($installer, $blockmap, $manifest, $runtimeSourceArchive, $legalArchive)) {
    if (-not (Test-Path -LiteralPath $file)) { throw "Release file was not found: $file" }
  }

  Invoke-CheckedCommand { gh auth setup-git } 'Unable to configure GitHub authentication for Git.'
  Invoke-CheckedCommand { git clone "https://github.com/$repository.git" $releaseCheckout } 'Unable to clone the release repository.'

  Push-Location $releaseCheckout
  try {
    $commitName = (git -C $projectDirectory config user.name).Trim()
    $commitEmail = (git -C $projectDirectory config user.email).Trim()
    if (-not $commitName -or $commitEmail -notlike '*@users.noreply.github.com') { throw 'Configure a GitHub noreply commit identity before publishing.' }
    Invoke-CheckedCommand { git config user.name $commitName } 'Unable to set the release commit author.'
    Invoke-CheckedCommand { git config user.email $commitEmail } 'Unable to set the release commit email.'
    Invoke-CheckedCommand { git config gpg.format ssh } 'Unable to enable SSH signing.'
    Invoke-CheckedCommand { git config user.signingkey $signingKey } 'Unable to select the SSH signing key.'
    Invoke-CheckedCommand { git config commit.gpgsign true } 'Unable to require signed commits.'

    $sourceCommit = (git -C $projectDirectory rev-parse HEAD).Trim()
    if ($LASTEXITCODE -ne 0) { throw 'Unable to resolve the source commit.' }
    $releaseState = [ordered]@{
      version = $version
      tag = $tag
      sourceRepository = 'Ktoto59/obhod-source'
      sourceCommit = $sourceCommit
      runtimeSourceRevision = $gplRuntime.revision
      runtimeSourceArchiveSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $runtimeSourceArchive).Hash.ToLowerInvariant()
      preparedAt = [DateTime]::UtcNow.ToString('o')
    }
    $releaseState | ConvertTo-Json | Set-Content -Encoding UTF8 (Join-Path $releaseCheckout 'release-state.json')

    Invoke-CheckedCommand { git add release-state.json } 'Unable to stage the release marker.'
    Invoke-CheckedCommand { git commit -S -m "Prepare release $tag" } 'Unable to create the signed release commit.'
    $releaseCommit = (git rev-parse HEAD).Trim()
    if ($LASTEXITCODE -ne 0) { throw 'Unable to resolve the release commit.' }
    Invoke-CheckedCommand { git push origin main } 'Unable to push the signed release commit.'
  }
  finally {
    Pop-Location
  }

  $commitResponse = gh api "repos/$repository/commits/$releaseCommit" | ConvertFrom-Json
  if ($LASTEXITCODE -ne 0) { throw 'Unable to verify the release commit through GitHub API.' }
  if ($commitResponse.commit.verification.verified -ne $true) {
    throw "GitHub did not verify release commit ${releaseCommit}: $($commitResponse.commit.verification.reason)"
  }

  $releaseArguments = @(
    'release', 'create', $tag, $installer, $blockmap, $manifest, $runtimeSourceArchive, $legalArchive,
    '--repo', $repository, '--target', $releaseCommit, '--title', "$productName $version"
  )
  if (Test-Path -LiteralPath $notesFile) {
    $releaseArguments += @('--notes-file', $notesFile)
  } else {
    $releaseArguments += @('--notes', "$productName $version. Windows installer and automatic update files.")
  }
  Invoke-CheckedCommand { gh @releaseArguments } 'Unable to create the GitHub Release.'
}
finally {
  Pop-Location
  if (Test-Path -LiteralPath $releaseCheckout) {
    $resolvedTemp = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
    $resolvedCheckout = [System.IO.Path]::GetFullPath($releaseCheckout)
    if (-not $resolvedCheckout.StartsWith($resolvedTemp, [System.StringComparison]::OrdinalIgnoreCase)) {
      throw "Refusing to remove an unsafe temporary path: $resolvedCheckout"
    }
    Remove-Item -LiteralPath $resolvedCheckout -Recurse -Force
  }
}
