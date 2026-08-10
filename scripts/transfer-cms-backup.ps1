[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$BackupPath,

  [Parameter(Mandatory = $true)]
  [ValidatePattern("^[A-Za-z0-9_.@-]+$")]
  [string]$DestinationHost,

  [Parameter(Mandatory = $true)]
  [ValidatePattern("^/[A-Za-z0-9_./-]+$")]
  [string]$DestinationPath,

  [Parameter(Mandatory = $true)]
  [ValidatePattern("^[A-Fa-f0-9]{64}$")]
  [string]$ExpectedDecryptedSha256
)

$ErrorActionPreference = "Stop"
if ($DestinationHost -notmatch "^[A-Za-z0-9_.@-]+$") {
  throw "DestinationHost contains unsupported characters"
}
if ($DestinationPath.Contains("..")) {
  throw "DestinationPath cannot contain parent traversal"
}

$resolvedBackupPath = [System.IO.Path]::GetFullPath($BackupPath)
if (-not (Test-Path -LiteralPath $resolvedBackupPath -PathType Leaf)) {
  throw "Encrypted backup does not exist"
}
$resolvedTemporaryRoot = [System.IO.Path]::GetFullPath($env:TEMP)
$temporaryRestore = Join-Path $resolvedTemporaryRoot (
  "odyshell-cms-restore-" + [guid]::NewGuid().ToString("N") + ".dump"
)
if (-not $temporaryRestore.StartsWith(
  $resolvedTemporaryRoot,
  [System.StringComparison]::OrdinalIgnoreCase
)) {
  throw "Temporary restore path escaped the Windows temp directory"
}

try {
  $decodedBackup = Unprotect-CmsMessage -Path $resolvedBackupPath
  [System.IO.File]::WriteAllBytes(
    $temporaryRestore,
    [Convert]::FromBase64String($decodedBackup)
  )
  $decryptedHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $temporaryRestore).Hash
  if ($decryptedHash -ne $ExpectedDecryptedSha256.ToUpperInvariant()) {
    throw "Decrypted backup hash does not match the verified manifest"
  }

  & scp -q -- $temporaryRestore "${DestinationHost}:${DestinationPath}"
  if ($LASTEXITCODE -ne 0) {
    throw "Could not transfer the decrypted backup"
  }
  & ssh -- $DestinationHost "chmod 600 '$DestinationPath'"
  if ($LASTEXITCODE -ne 0) {
    throw "Could not restrict the transferred backup permissions"
  }

  [pscustomobject]@{
    Destination = "${DestinationHost}:${DestinationPath}"
    DecryptedSha256 = $decryptedHash
    Permissions = "600"
  }
} finally {
  if (Test-Path -LiteralPath $temporaryRestore) {
    Remove-Item -LiteralPath $temporaryRestore -Force
  }
}
