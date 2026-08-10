[CmdletBinding()]
param(
  [Parameter()]
  [string]$OutputDirectory = "C:\Users\karim\Backups\Odyshell",

  [Parameter()]
  [string]$Service = "Postgres"
)

$ErrorActionPreference = "Stop"
$resolvedOutputDirectory = [System.IO.Path]::GetFullPath($OutputDirectory)
$resolvedTemporaryRoot = [System.IO.Path]::GetFullPath(
  (Join-Path $env:TEMP ("odyshell-cloud-backup-" + [guid]::NewGuid().ToString("N")))
)
$resolvedWindowsTemp = [System.IO.Path]::GetFullPath($env:TEMP)
if (-not $resolvedTemporaryRoot.StartsWith(
  $resolvedWindowsTemp,
  [System.StringComparison]::OrdinalIgnoreCase
)) {
  throw "Temporary backup path escaped the Windows temp directory"
}

New-Item -ItemType Directory -Force -Path $resolvedOutputDirectory | Out-Null
New-Item -ItemType Directory -Path $resolvedTemporaryRoot | Out-Null

$dumpPath = Join-Path $resolvedTemporaryRoot "odyshell-cloud.dump"
$verifyPath = Join-Path $resolvedTemporaryRoot "odyshell-cloud-verified.dump"
$restoreListPath = Join-Path $resolvedTemporaryRoot "restore-list.txt"
$backupStamp = Get-Date -Format "yyyyMMdd-HHmmss"
$encryptedPath = Join-Path $resolvedOutputDirectory "odyshell-cloud-$backupStamp.dump.b64.p7m"
$certificatePath = Join-Path $resolvedOutputDirectory "odyshell-cloud-backup-public-$backupStamp.cer"
$manifestPath = Join-Path $resolvedOutputDirectory "odyshell-cloud-$backupStamp.manifest.json"

try {
  $railwayVariables = railway variables --service $Service --json | ConvertFrom-Json
  if ($LASTEXITCODE -ne 0) {
    throw "Could not read Railway PostgreSQL connection variables"
  }

  $env:PGHOST = [string]$railwayVariables.RAILWAY_TCP_PROXY_DOMAIN
  $env:PGPORT = [string]$railwayVariables.RAILWAY_TCP_PROXY_PORT
  $env:PGUSER = [string]$railwayVariables.PGUSER
  $env:PGPASSWORD = [string]$railwayVariables.PGPASSWORD
  $env:PGDATABASE = [string]$railwayVariables.PGDATABASE

  $postgresEnvironmentArguments = @(
    "--env", "PGHOST",
    "--env", "PGPORT",
    "--env", "PGUSER",
    "--env", "PGPASSWORD",
    "--env", "PGDATABASE"
  )
  $readyArguments = @("run", "--rm") + $postgresEnvironmentArguments + @(
    "postgres:18-alpine", "pg_isready"
  )
  $readyProcess = Start-Process -FilePath docker -ArgumentList $readyArguments `
    -Wait -PassThru -NoNewWindow
  if ($readyProcess.ExitCode -ne 0) {
    throw "Railway PostgreSQL public proxy is not reachable"
  }

  $dumpArguments = @("run", "--rm") + $postgresEnvironmentArguments + @(
    "postgres:18-alpine", "pg_dump", "--format=custom", "--no-owner", "--no-privileges"
  )
  $dumpProcess = Start-Process -FilePath docker -ArgumentList $dumpArguments `
    -RedirectStandardOutput $dumpPath -Wait -PassThru -NoNewWindow
  if (
    $dumpProcess.ExitCode -ne 0 -or
    -not (Test-Path -LiteralPath $dumpPath) -or
    (Get-Item -LiteralPath $dumpPath).Length -eq 0
  ) {
    throw "Railway PostgreSQL dump failed or was empty"
  }

  $backupCertificate = Get-ChildItem Cert:\CurrentUser\My |
    Where-Object {
      $_.Subject -eq "CN=Odyshell Cloud Backup" -and
      $_.NotAfter -gt (Get-Date).AddYears(1) -and
      $_.HasPrivateKey
    } |
    Sort-Object NotAfter -Descending |
    Select-Object -First 1
  if (-not $backupCertificate) {
    $backupCertificate = New-SelfSignedCertificate `
      -Type DocumentEncryptionCert `
      -Subject "CN=Odyshell Cloud Backup" `
      -CertStoreLocation "Cert:\CurrentUser\My" `
      -KeyAlgorithm RSA `
      -KeyLength 3072 `
      -NotAfter (Get-Date).AddYears(10)
  }
  Export-Certificate -Cert $backupCertificate -FilePath $certificatePath -Force | Out-Null

  $dumpBase64 = [Convert]::ToBase64String([System.IO.File]::ReadAllBytes($dumpPath))
  Protect-CmsMessage -Content $dumpBase64 -To $backupCertificate -OutFile $encryptedPath
  $verifiedBase64 = Unprotect-CmsMessage -Path $encryptedPath
  [System.IO.File]::WriteAllBytes(
    $verifyPath,
    [Convert]::FromBase64String($verifiedBase64)
  )

  $sourceHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $dumpPath).Hash
  $verifiedHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $verifyPath).Hash
  if ($sourceHash -ne $verifiedHash) {
    throw "Encrypted backup verification hash mismatch"
  }

  $restoreProcess = Start-Process -FilePath docker -ArgumentList @(
    "run", "--rm",
    "--volume", "${verifyPath}:/backup.dump:ro",
    "postgres:18-alpine", "pg_restore", "--list", "/backup.dump"
  ) -RedirectStandardOutput $restoreListPath -Wait -PassThru -NoNewWindow
  if ($restoreProcess.ExitCode -ne 0) {
    throw "pg_restore could not parse the decrypted backup"
  }

  $encryptedHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $encryptedPath).Hash
  $manifest = [ordered]@{
    createdAt = (Get-Date).ToUniversalTime().ToString("o")
    source = "Railway project odyshell / production / $Service"
    format = "PostgreSQL custom dump, Base64, CMS encrypted"
    encryptedFile = [System.IO.Path]::GetFileName($encryptedPath)
    encryptedSha256 = $encryptedHash
    encryptedBytes = (Get-Item -LiteralPath $encryptedPath).Length
    decryptedSha256 = $sourceHash
    certificateThumbprint = $backupCertificate.Thumbprint
    verification = "CMS decrypt hash match and pg_restore --list passed"
  }
  $manifest | ConvertTo-Json | Set-Content -LiteralPath $manifestPath -Encoding UTF8

  [pscustomobject]@{
    EncryptedBackup = $encryptedPath
    Manifest = $manifestPath
    PublicCertificate = $certificatePath
    EncryptedSha256 = $encryptedHash
    EncryptedBytes = (Get-Item -LiteralPath $encryptedPath).Length
    Verification = $manifest.verification
  }
} finally {
  Remove-Item Env:PGHOST, Env:PGPORT, Env:PGUSER, Env:PGPASSWORD, Env:PGDATABASE `
    -ErrorAction SilentlyContinue
  foreach ($temporaryFile in @($dumpPath, $verifyPath, $restoreListPath)) {
    if (Test-Path -LiteralPath $temporaryFile) {
      Remove-Item -LiteralPath $temporaryFile -Force
    }
  }
  if (Test-Path -LiteralPath $resolvedTemporaryRoot) {
    Remove-Item -LiteralPath $resolvedTemporaryRoot -Force
  }
}
