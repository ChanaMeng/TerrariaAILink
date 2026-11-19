# 一键把鲸白送进世界：起客户端 → 必要时点角色 → 起 daemon → 报状态
# 前提：主人已经在主客户端里 "建立并游玩"，7777 在监听。

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

$root = 'E:\deepseekWorkspace\terraria'
$daemon = Join-Path $root 'daemon'
$dotnet = 'C:\Program Files\dotnet\dotnet.exe'
$node = 'C:\Program Files\nodejs\node.exe'
$tml = 'D:\steam\steamapps\common\tModLoader'
$profile = 'E:\deepseekWorkspace\terraria-ai-profile'

Add-Type -Name WhaleWin -Namespace '' -MemberDefinition @'
[StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
[StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT { public int dx, dy; public uint mouseData, dwFlags, time; public IntPtr dwExtraInfo; }
[StructLayout(LayoutKind.Explicit)] public struct INPUT { [FieldOffset(0)] public uint type; [FieldOffset(8)] public MOUSEINPUT mi; }
[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
[DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
[DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr h, ref POINT p);
[DllImport("user32.dll")] public static extern uint SendInput(uint n, INPUT[] inputs, int size);
public static void Focus(IntPtr h) { ShowWindow(h, 9); SetForegroundWindow(h); System.Threading.Thread.Sleep(300); }
public static void ClickClient(IntPtr h, int x, int y) {
  POINT p; p.X = x; p.Y = y; ClientToScreen(h, ref p);
  SetCursorPos(p.X, p.Y); System.Threading.Thread.Sleep(120);
  INPUT d = new INPUT(); d.type = 0; d.mi.dwFlags = 2;
  INPUT u = new INPUT(); u.type = 0; u.mi.dwFlags = 4;
  int sz = Marshal.SizeOf(typeof(INPUT));
  SendInput(1, new INPUT[] { d }, sz);
  System.Threading.Thread.Sleep(90);
  SendInput(1, new INPUT[] { u }, sz);
}
'@

function Say($msg) { Write-Host "[鲸白] $msg" -ForegroundColor Cyan }
function Warn($msg) { Write-Host "[鲸白] $msg" -ForegroundColor Yellow }

# ---- 0. 主世界开好了吗 ----
$host7777 = Get-NetTCPConnection -State Listen -LocalPort 7777 -ErrorAction SilentlyContinue
if (-not $host7777) {
  Warn '7777 没有在监听——先在主客户端里「建立并游玩」，再点这个脚本。'
  Read-Host '按回车关闭'
  exit 1
}
Say '世界在 7777 上，开始。'

# ---- 1. 关掉旧的鲸白端 ----
$old = Get-CimInstance Win32_Process -Filter "Name='dotnet.exe'" |
  Where-Object { $_.CommandLine -like '*terraria-ai-profile*' }
foreach ($p in $old) {
  Say "关掉旧客户端 pid=$($p.ProcessId)"
  Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
}
Start-Sleep -Seconds 2

# ---- 2. 起客户端 ----
Say '启动鲸白客户端…'
$proc = Start-Process -FilePath $dotnet `
  -ArgumentList ('tModLoader.dll -tmlsavedirectory "{0}" -join 127.0.0.1 -port 7777' -f $profile) `
  -WorkingDirectory $tml -PassThru
$pidAi = $proc.Id

function Connected {
  param($id)
  $c = Get-NetTCPConnection -OwningProcess $id -ErrorAction SilentlyContinue |
    Where-Object { $_.RemotePort -eq 7777 -and $_.State -eq 'Established' }
  return [bool]$c
}

# ---- 3. 等它自己连；连不上就点角色 ----
$deadline = (Get-Date).AddSeconds(90)
$clicks = 0
while ((Get-Date) -lt $deadline) {
  Start-Sleep -Seconds 2
  if (Connected $pidAi) { break }
  $win = Get-Process -Id $pidAi -ErrorAction SilentlyContinue
  if (-not $win -or $win.MainWindowHandle -eq 0) { continue }
  if ($clicks -lt 3 -and $win.StartTime.AddSeconds(18 + $clicks * 14) -lt (Get-Date)) {
    Say "停在选择玩家界面，点一下 Jingbai（第 $($clicks + 1) 次）…"
    [WhaleWin]::Focus($win.MainWindowHandle)
    Start-Sleep -Milliseconds 400
    [WhaleWin]::ClickClient($win.MainWindowHandle, 400, 269)
    $clicks++
  }
}

if (-not (Connected $pidAi)) {
  Warn '还不能连上 7777。检查主客户端是不是还开着、世界有没有退。'
  Read-Host '按回车关闭'
  exit 1
}
Say "鲸白进世界了（pid=$pidAi）。"

# ---- 4. 起 daemon ----
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -like '*src/main.mjs*' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Start-Sleep -Milliseconds 800

Start-Process -FilePath $node -ArgumentList 'src/main.mjs' -WorkingDirectory $daemon `
  -RedirectStandardOutput (Join-Path $daemon 'daemon.out.log') `
  -RedirectStandardError (Join-Path $daemon 'daemon.err.log') -WindowStyle Hidden
Start-Sleep -Seconds 3

# ---- 5. 报状态 ----
try {
  $st = Invoke-RestMethod 'http://127.0.0.1:17891/status' -TimeoutSec 5
  $p = $st.player
  Say ("桥通了：link={0} 位置=({1},{2}) 血={3}/{4} 手持={5}" -f $st.link, [int]$p.x, [int]$p.y, $p.hp, $p.mhp, $p.item)
  Say '可以开始玩了。要叫我就在游戏里喊「鲸白」。'
} catch {
  Warn "daemon 起来了但 /status 不通：$($_.Exception.Message)"
}

Read-Host '按回车关闭窗口'
