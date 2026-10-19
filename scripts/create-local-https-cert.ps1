param(
  [string]$LanIp = '192.168.0.4'
)

$ErrorActionPreference = 'Stop'
$openssl = (Get-Command openssl -ErrorAction Stop).Source
$certDir = Join-Path $PSScriptRoot '..\.local-https'
New-Item -ItemType Directory -Force -Path $certDir | Out-Null
$certDir = (Resolve-Path $certDir).Path
$caKey = Join-Path $certDir 'local-dev-ca.key'
$caCert = Join-Path $certDir 'local-dev-ca.crt'
$key = Join-Path $certDir "$LanIp.key"
$csr = Join-Path $certDir "$LanIp.csr"
$cert = Join-Path $certDir "$LanIp.crt"
$extensions = Join-Path $certDir 'server-extensions.cnf'

if (-not (Test-Path $caCert)) {
  & $openssl req -x509 -newkey rsa:2048 -sha256 -days 365 -nodes `
    -keyout $caKey -out $caCert -subj '/CN=Looply Local Development CA' `
    -addext 'basicConstraints=critical,CA:TRUE' `
    -addext 'keyUsage=critical,keyCertSign,cRLSign' `
    -addext 'subjectKeyIdentifier=hash'
  if ($LASTEXITCODE -ne 0) { throw 'Could not create local certificate authority.' }
}

@"
basicConstraints=critical,CA:FALSE
keyUsage=critical,digitalSignature,keyEncipherment
extendedKeyUsage=serverAuth
subjectAltName=@alt_names
[alt_names]
IP.1=$LanIp
IP.2=127.0.0.1
DNS.1=localhost
"@ | Set-Content -Encoding ascii $extensions

& $openssl req -new -newkey rsa:2048 -nodes -keyout $key -out $csr `
  -subj "/CN=$LanIp"
if ($LASTEXITCODE -ne 0) { throw 'Could not create local HTTPS server key.' }

& $openssl x509 -req -in $csr -CA $caCert -CAkey $caKey -CAcreateserial `
  -out $cert -days 365 -sha256 -extfile $extensions
if ($LASTEXITCODE -ne 0) { throw 'Could not sign local HTTPS server certificate.' }

Write-Host "Local HTTPS certificate created for https://$($LanIp):5173"
Write-Host 'Restart npm run dev to use it. Install local-dev-ca.crt on your phone and trust it as a CA certificate.'
