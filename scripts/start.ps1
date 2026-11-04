param([switch]$NoBrowser)
$ErrorActionPreference='Stop'
trap {
  $launchError=$_.Exception.Message
  Write-Error -Message $launchError -ErrorAction Continue
  # 桌面入口隐藏 PowerShell 窗口，必须另行显示失败原因。
  if(-not $NoBrowser){
    try {
      $launchShell=New-Object -ComObject WScript.Shell
      $null=$launchShell.Popup($launchError,0,'提示词工坊 · 启动未完成',48)
    } catch { Write-Error -Message '无法显示启动错误提示。' -ErrorAction Continue }
  }
  exit 1
}
$projectDir=Split-Path -Parent $PSScriptRoot
$port=18765
if($env:PW_PORT){$port=[int]$env:PW_PORT}
if($port -lt 1 -or $port -gt 65535){throw 'PW_PORT必须为1–65535'}
$dataDir=Join-Path $projectDir 'data'
if($env:PW_DATA_DIR){$dataDir=[IO.Path]::GetFullPath($env:PW_DATA_DIR)}
$env:PW_DATA_DIR=$dataDir
$runtimeFile=Join-Path $dataDir 'local-runtime.json'
if(Test-Path -LiteralPath $runtimeFile){
  $runtimeSettings=Get-Content -LiteralPath $runtimeFile -Raw -Encoding UTF8 | ConvertFrom-Json
  foreach($runtimeKey in @('PW_ROUTER_INI','PW_ROUTER_MANAGER','PW_ROUTER_URL')){
    if(-not [Environment]::GetEnvironmentVariable($runtimeKey,'Process') -and $runtimeSettings.$runtimeKey){[Environment]::SetEnvironmentVariable($runtimeKey,[string]$runtimeSettings.$runtimeKey,'Process')}
  }
}
$url="http://127.0.0.1:$port"
$expectedVersion=(Get-Content -LiteralPath (Join-Path $projectDir 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json).version
$dataRoot=[IO.Path]::GetPathRoot($dataDir)
if($dataDir.Length -gt $dataRoot.Length){$dataDir=$dataDir.TrimEnd([char]92,[char]47)}
$sha=[Security.Cryptography.SHA256]::Create()
$instance=([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes(($projectDir+'|'+$dataDir).ToLowerInvariant())))).Replace('-','').ToLower().Substring(0,16)
$sha.Dispose()
$r=$null
try {$r=Invoke-RestMethod -Uri "$url/health" -TimeoutSec 2} catch {}
if($r -and ($r.app -ne 'prompt-workbench' -or $r.instance -ne $instance)){throw '端口被其他实例占用，请设置不同的PW_PORT；未停止已有服务'}
if($r -and $r.version -ne $expectedVersion){
  # 已核实为同目录实例：打开现有页面供保存和关闭，仍拒绝把旧版当作启动成功。
  if(-not $NoBrowser){Start-Process $url}
  throw "旧服务尚未退出（$($r.version)，程序$expectedVersion）。请在已打开的页面保存输入，点击「服务 → 关闭服务」，等到退出确认后重新打开桌面图标；未复用旧版，也未强制中断服务。"
}
if(-not $r){
  $nodePath=(Get-Command node.exe -ErrorAction Stop).Source
  if([int]((& $nodePath --version).TrimStart('v').Split('.')[0]) -lt 24){throw '需要Node.js24或更高版本'}
  New-Item -ItemType Directory -Path $dataDir -Force | Out-Null
  Start-Process -FilePath $nodePath -ArgumentList @('src/server.js') -WorkingDirectory $projectDir -WindowStyle Hidden -RedirectStandardOutput (Join-Path $dataDir 'app.stdout.log') -RedirectStandardError (Join-Path $dataDir 'app.stderr.log') | Out-Null
  $ready=$false
  for($i=0;$i -lt 30;$i++){Start-Sleep -Milliseconds 300;try{$r=Invoke-RestMethod -Uri "$url/health" -TimeoutSec 1;if($r.app -eq 'prompt-workbench' -and $r.instance -eq $instance -and $r.version -eq $expectedVersion){$ready=$true;break}}catch{}}
  if(-not $ready){throw '工作台启动失败，请查看数据目录app.stderr.log'}
}
if(-not $NoBrowser){Start-Process $url}
Write-Output "提示词工坊已启动：$url"
