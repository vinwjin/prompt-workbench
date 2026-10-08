$ErrorActionPreference='Stop'
$projectDir=Split-Path -Parent $PSScriptRoot
$iconPath=Join-Path $projectDir 'public\workbench.ico'
if(-not (Test-Path -LiteralPath $iconPath)){throw '请先生成工作台图标，再安装快捷方式'}
$targetPath=Join-Path $env:SystemRoot 'System32\wscript.exe'
$launcherPath=Join-Path $PSScriptRoot 'launch.vbs'
$desktopDir=[Environment]::GetFolderPath('DesktopDirectory')
$programsDir=[Environment]::GetFolderPath('Programs')
$menuDir=Join-Path $programsDir '提示词工坊'
New-Item -ItemType Directory -Path $menuDir -Force | Out-Null
$shell=New-Object -ComObject WScript.Shell
$paths=@((Join-Path $desktopDir '提示词工坊.lnk'),(Join-Path $menuDir '提示词工坊.lnk'))
$result=@()
foreach($linkPath in $paths){
  if(Test-Path -LiteralPath $linkPath){
    $existing=$shell.CreateShortcut($linkPath)
    $belongs=($existing.WorkingDirectory -eq $projectDir) -or ($existing.TargetPath -like "$projectDir\*") -or ($existing.Arguments -like "*$projectDir*")
    if(-not $belongs){throw "同名快捷方式属于其他程序，未覆盖：$linkPath"}
  }
  $shortcut=$shell.CreateShortcut($linkPath)
  $shortcut.TargetPath=$targetPath
  $shortcut.Arguments='"'+$launcherPath+'"'
  $shortcut.WorkingDirectory=$projectDir
  $shortcut.IconLocation=$iconPath+',0'
  $shortcut.Description='提示词工坊：本地模型、模板、资料库与分享广场'
  $shortcut.WindowStyle=7
  $shortcut.Save()
  $readback=$shell.CreateShortcut($linkPath)
  if($readback.TargetPath -ne $targetPath -or $readback.IconLocation -ne ($iconPath+',0')){throw '快捷方式回读校验失败'}
  $result+=[pscustomobject]@{path=$linkPath;target=$readback.TargetPath;arguments=$readback.Arguments;icon=$readback.IconLocation;verified=$true}
}
$result | ConvertTo-Json -Depth 4
