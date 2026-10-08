param([switch]$NoBrowser)
$ErrorActionPreference='Stop'
$projectDir=Split-Path -Parent $PSScriptRoot
$port=18765
if($env:PW_PORT){$port=[int]$env:PW_PORT}
if($port -lt 1 -or $port -gt 65535){throw 'PW_PORT必须为1–65535'}
$dataDir=Join-Path $projectDir 'data'
if($env:PW_DATA_DIR){$dataDir=[IO.Path]::GetFullPath($env:PW_DATA_DIR)}
$env:PW_DATA_DIR=$dataDir
$url="http://127.0.0.1:$port"
$dataRoot=[IO.Path]::GetPathRoot($dataDir)
if($dataDir.Length -gt $dataRoot.Length){$dataDir=$dataDir.TrimEnd([char]92,[char]47)}
$sha=[Security.Cryptography.SHA256]::Create()
$instance=([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes(($projectDir+'|'+$dataDir).ToLowerInvariant())))).Replace('-','').ToLower().Substring(0,16)
$sha.Dispose()
$r=$null
try {$r=Invoke-RestMethod -Uri "$url/health" -TimeoutSec 2} catch {}
if($r -and ($r.app -ne 'prompt-workbench' -or $r.instance -ne $instance)){throw '端口被其他实例占用，请设置不同的PW_PORT；未停止已有服务'}
if(-not $r){
  $nodePath=(Get-Command node.exe -ErrorAction Stop).Source
  if([int]((& $nodePath --version).TrimStart('v').Split('.')[0]) -lt 24){throw '需要Node.js24或更高版本'}
  New-Item -ItemType Directory -Path $dataDir -Force | Out-Null
  Start-Process -FilePath $nodePath -ArgumentList @('src/server.js') -WorkingDirectory $projectDir -WindowStyle Hidden -RedirectStandardOutput (Join-Path $dataDir 'app.stdout.log') -RedirectStandardError (Join-Path $dataDir 'app.stderr.log') | Out-Null
  $ready=$false
  for($i=0;$i -lt 30;$i++){Start-Sleep -Milliseconds 300;try{$r=Invoke-RestMethod -Uri "$url/health" -TimeoutSec 1;if($r.app -eq 'prompt-workbench' -and $r.instance -eq $instance){$ready=$true;break}}catch{}}
  if(-not $ready){throw '工作台启动失败，请查看数据目录app.stderr.log'}
}
if(-not $NoBrowser){Start-Process $url}
Write-Output "提示词工坊已启动：$url"
