#Requires -Version 7.0
#Requires -PSEdition Core
<#
.SYNOPSIS
    Run local pi-transcribe dictation from a Windows-wide hotkey.

.DESCRIPTION
    Starts an independent Node daemon that reuses pi-transcribe's existing model and settings.
    Press the hotkey once to record and again to transcribe and paste into the foreground app.

.EXAMPLE
    pwsh -NoProfile -Sta -ExecutionPolicy Bypass -File .\windows\pi-transcribe.ps1
#>
[CmdletBinding()]
param(
    [switch]$ValidateOnly
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if (-not $IsWindows) {
    throw 'Windows dictation is only supported on Windows.'
}
if ([Threading.Thread]::CurrentThread.GetApartmentState() -ne [Threading.ApartmentState]::STA) {
    throw 'Run this app with pwsh -Sta so it can use the clipboard.'
}

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

function Get-AutocorrectPath {
    $Configured = $env:PI_TRANSCRIBE_AUTOCORRECT_PATH
    if ($Configured -and (Test-Path -LiteralPath $Configured -PathType Leaf)) {
        return $Configured
    }

    $AgentDir = $env:PI_CODING_AGENT_DIR
    if (-not $AgentDir) {
        $AgentDir = Join-Path $HOME '.pi\agent'
    }
    $Candidate = Join-Path $AgentDir 'bin\autocorrect.exe'
    if (Test-Path -LiteralPath $Candidate -PathType Leaf) {
        return $Candidate
    }
}

function Format-TranscriptText {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string]$Text
    )

    if (-not $script:AutocorrectPath -or $Text -notmatch '\p{IsCJKUnifiedIdeographs}') {
        return $Text
    }

    try {
        $Formatted = @(
            $Text | & $script:AutocorrectPath --stdin --type txt --no-diff-bg-color 2>$null
        ) -join [Environment]::NewLine
        if ($LASTEXITCODE -eq 0 -and -not [string]::IsNullOrWhiteSpace($Formatted)) {
            return $Formatted.Trim()
        }
    } catch {
        Write-Verbose "autocorrect failed: $($_.Exception.Message)"
    }
    return $Text
}

function Set-AppStatus {
    param(
        [Parameter(Mandatory)]
        [string]$Status
    )

    $script:Tray.Text = "Pi Transcribe: $Status"
}

function Show-AppNotification {
    param(
        [Parameter(Mandatory)]
        [string]$Text,

        [System.Windows.Forms.ToolTipIcon]$Icon = [System.Windows.Forms.ToolTipIcon]::Info
    )

    $script:Tray.ShowBalloonTip(2000, 'Pi Transcribe', $Text, $Icon)
}

function Send-TranscriptPaste {
    param(
        [Parameter(Mandatory)]
        [string]$Text
    )

    $Formatted = Format-TranscriptText -Text $Text
    try {
        [System.Windows.Forms.Clipboard]::SetText($Formatted)
        [System.Windows.Forms.SendKeys]::SendWait('^v')
        Set-AppStatus -Status 'Pasted'
    } catch {
        Set-AppStatus -Status 'Paste failed'
        Show-AppNotification -Text $_.Exception.Message -Icon Error
    }
}

function Send-DaemonCommand {
    param(
        [Parameter(Mandatory)]
        [string]$Command
    )

    if (-not $script:Window.DaemonRunning) {
        Set-AppStatus -Status 'Daemon stopped'
        Show-AppNotification -Text 'The dictation daemon has stopped.' -Icon Error
        return
    }

    try {
        $script:Window.SendDaemon($Command)
    } catch {
        Set-AppStatus -Status 'Daemon unavailable'
        Show-AppNotification -Text $_.Exception.Message -Icon Error
    }
}

function Receive-DaemonMessage {
    param(
        [Parameter(Mandatory)]
        [PSCustomObject]$Message
    )

    switch ([string]$Message.type) {
        'ready' {
            Set-AppStatus -Status 'Ready'
            Show-AppNotification -Text "Ready with $($Message.model). Press Ctrl+Alt+\ to dictate."
        }
        'recording' {
            Set-AppStatus -Status 'Recording'
        }
        'transcribing' {
            Set-AppStatus -Status 'Transcribing'
        }
        'transcript' {
            Send-TranscriptPaste -Text ([string]$Message.text)
        }
        'empty' {
            Set-AppStatus -Status 'No speech'
        }
        'busy' {
            Set-AppStatus -Status 'Busy'
        }
        'error' {
            Set-AppStatus -Status 'Error'
            Show-AppNotification -Text ([string]$Message.message) -Icon Error
        }
        'stopped' {
            Set-AppStatus -Status 'Stopped'
        }
    }
}

$HotkeySource = @'
using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Windows.Forms;

public delegate void PiDaemonLineDelegate(string line);

public sealed class PiTranscribeHotkeyWindow : Form
{
    const int WM_HOTKEY = 0x0312;
    const int HotkeyId = 1;
    const uint Modifiers = 0x4003; // Ctrl + Alt + MOD_NOREPEAT
    const uint Key = 0xDC; // VK_OEM_5 (backslash)

    Process daemon;

    [DllImport("user32.dll", SetLastError = true)]
    static extern bool RegisterHotKey(IntPtr hWnd, int id, uint modifiers, uint key);

    [DllImport("user32.dll", SetLastError = true)]
    static extern bool UnregisterHotKey(IntPtr hWnd, int id);

    public event EventHandler HotkeyPressed;
    public event EventHandler DaemonMessage;
    public string DaemonLine { get; private set; }
    public bool DaemonRunning { get { return daemon != null && !daemon.HasExited; } }

    public PiTranscribeHotkeyWindow()
    {
        ShowInTaskbar = false;
        CreateControl();
        if (!RegisterHotKey(Handle, HotkeyId, Modifiers, Key))
            throw new Exception("Could not register the global hotkey (Win32 error " + Marshal.GetLastWin32Error() + ").");
    }

    public void StartDaemon(string node, string script)
    {
        StopDaemon();
        var info = new ProcessStartInfo {
            FileName = node,
            UseShellExecute = false,
            RedirectStandardInput = true,
            RedirectStandardOutput = true,
            StandardOutputEncoding = Encoding.UTF8,
        };
        info.ArgumentList.Add(script);
        var process = new Process { StartInfo = info };
        process.OutputDataReceived += OnDaemonOutput;
        try {
            if (!process.Start())
                throw new Exception("Could not start the dictation daemon.");
            daemon = process;
            process.BeginOutputReadLine();
        } catch {
            if (daemon == process) daemon = null;
            process.Dispose();
            throw;
        }
    }

    public void SendDaemon(string command)
    {
        if (!DaemonRunning)
            throw new InvalidOperationException("The dictation daemon has stopped.");
        daemon.StandardInput.WriteLine(command);
        daemon.StandardInput.Flush();
    }

    public void StopDaemon()
    {
        var process = daemon;
        daemon = null;
        if (process == null) return;
        try {
            if (!process.HasExited) {
                try {
                    process.StandardInput.WriteLine("shutdown");
                    process.StandardInput.Flush();
                } catch (InvalidOperationException) { }
                if (!process.WaitForExit(5000)) {
                    try { process.Kill(); } catch (InvalidOperationException) { }
                }
            }
        } finally {
            process.Dispose();
        }
    }

    void OnDaemonOutput(object sender, DataReceivedEventArgs eventArgs)
    {
        if (eventArgs.Data == null) return;
        try {
            BeginInvoke(new PiDaemonLineDelegate(DeliverDaemonLine), eventArgs.Data);
        } catch (InvalidOperationException) { }
    }

    void DeliverDaemonLine(string line)
    {
        DaemonLine = line;
        var handler = DaemonMessage;
        if (handler != null) handler(this, EventArgs.Empty);
    }

    protected override void SetVisibleCore(bool value)
    {
        base.SetVisibleCore(false);
    }

    protected override void WndProc(ref Message message)
    {
        if (message.Msg == WM_HOTKEY && message.WParam.ToInt32() == HotkeyId && HotkeyPressed != null)
            HotkeyPressed(this, EventArgs.Empty);
        base.WndProc(ref message);
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing) StopDaemon();
        if (IsHandleCreated) UnregisterHotKey(Handle, HotkeyId);
        base.Dispose(disposing);
    }
}
'@

$References = @(
    [System.Windows.Forms.Form].Assembly.Location,
    [System.Windows.Forms.Message].Assembly.Location,
    [System.ComponentModel.Component].Assembly.Location,
    [System.Runtime.GCSettings].Assembly.Location,
    [System.Diagnostics.Process].Assembly.Location
) | Select-Object -Unique
if (-not ('PiTranscribeHotkeyWindow' -as [type])) {
    Add-Type -TypeDefinition $HotkeySource -ReferencedAssemblies $References
}

$DaemonPath = Join-Path $PSScriptRoot 'dictation-daemon.mjs'
if (-not (Test-Path -LiteralPath $DaemonPath -PathType Leaf)) {
    throw "Dictation daemon not found: $DaemonPath"
}
$NodeExecutable = (Get-Command -Name 'node.exe' -CommandType Application -ErrorAction Stop).Source
$script:AutocorrectPath = Get-AutocorrectPath
$script:Window = [PiTranscribeHotkeyWindow]::new()

if ($ValidateOnly) {
    try {
        Write-Output "Validated Ctrl+Alt+\ with $NodeExecutable"
    } finally {
        $script:Window.Dispose()
    }
    return
}

$script:Tray = [System.Windows.Forms.NotifyIcon]::new()
$script:Tray.Icon = [System.Drawing.SystemIcons]::Application
$script:Tray.Visible = $true
Set-AppStatus -Status 'Starting'

$Menu = [System.Windows.Forms.ContextMenuStrip]::new()
$ExitItem = [System.Windows.Forms.ToolStripMenuItem]::new('Exit')
$ExitItem.add_Click([System.EventHandler] {
    $script:Window.Close()
}.GetNewClosure())
[void]$Menu.Items.Add($ExitItem)
$script:Tray.ContextMenuStrip = $Menu

$script:Window.add_DaemonMessage([System.EventHandler] {
    param($Sender, $EventArgs)
    try {
        $Message = $Sender.DaemonLine | ConvertFrom-Json -ErrorAction Stop
    } catch {
        return
    }
    Receive-DaemonMessage -Message $Message
}.GetNewClosure())
$script:Window.add_HotkeyPressed([System.EventHandler] {
    Send-DaemonCommand -Command 'toggle'
}.GetNewClosure())

try {
    $script:Window.StartDaemon($NodeExecutable, $DaemonPath)
    [System.Windows.Forms.Application]::Run($script:Window)
} finally {
    $script:Window.StopDaemon()
    $script:Tray.Visible = $false
    $script:Tray.Dispose()
    $Menu.Dispose()
    $script:Window.Dispose()
}
