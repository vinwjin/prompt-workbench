$ErrorActionPreference='Stop'
$projectDir=Split-Path -Parent $PSScriptRoot
$port=18765
if($env:PW_PORT){$port=[int]$env:PW_PORT}
if($port -lt 1 -or $port -gt 65535){throw 'PW_PORT必须为1–65535'}
$dataDir=Join-Path $projectDir 'data'
if($env:PW_DATA_DIR){$dataDir=[IO.Path]::GetFullPath($env:PW_DATA_DIR)}
$dataRoot=[IO.Path]::GetPathRoot($dataDir)
if($dataDir.Length -gt $dataRoot.Length){$dataDir=$dataDir.TrimEnd([char]92,[char]47)}
$sha=[Security.Cryptography.SHA256]::Create()
$instance=([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes(($projectDir+'|'+$dataDir).ToLowerInvariant())))).Replace('-','').ToLower().Substring(0,16)
$sha.Dispose()
$url="http://127.0.0.1:$port"
$r=Invoke-RestMethod -Uri "$url/health" -TimeoutSec 3
if($r.app -ne 'prompt-workbench' -or $r.instance -ne $instance){throw '端口不是本目录和数据的实例，拒绝关闭其他服务'}
$session=New-Object Microsoft.PowerShell.Commands.WebRequestSession
$null=Invoke-WebRequest -UseBasicParsing -Uri "$url/" -WebSession $session -TimeoutSec 5
$null=Invoke-RestMethod -Method Post -Uri "$url/api/shutdown" -WebSession $session -ContentType 'application/json' -Body '{}' -TimeoutSec 10
$stopped=$false
for($i=0;$i -lt 30;$i++){Start-Sleep -Milliseconds 300;try{$null=Invoke-RestMethod -Uri "$url/health" -TimeoutSec 1}catch{$stopped=$true;break}}
if(-not $stopped){throw '服务尚未退出，可能仍在释放；未强杀，请查看应用反馈'}
Write-Output '已确认本实例关闭。'
