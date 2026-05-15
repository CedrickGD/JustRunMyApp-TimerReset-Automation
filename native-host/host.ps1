# JRM Reset Native Host (PowerShell Prototype)
$ErrorActionPreference = 'Stop'

$logFile = Join-Path $PSScriptRoot "host.log"
$configFile = Join-Path $PSScriptRoot "config.json"

function Log($message) {
    $timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    "[$timestamp] $message" | Out-File -FilePath $logFile -Append
}

function Send-Message($messageObj) {
    $json = $messageObj | ConvertTo-Json -Compress
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($json)
    $length = $bytes.Length
    
    $stdout = [System.Console]::OpenStandardOutput()
    $stdout.Write([System.BitConverter]::GetBytes([uint32]$length), 0, 4)
    $stdout.Write($bytes, 0, $length)
    $stdout.Flush()
}

Log "Host started."

try {
    $stdin = [System.Console]::OpenStandardInput()
    
    while ($true) {
        # Read length (4 bytes)
        $lenBytes = New-Object byte[] 4
        $read = $stdin.Read($lenBytes, 0, 4)
        if ($read -ne 4) { break }
        
        $length = [System.BitConverter]::ToUInt32($lenBytes, 0)
        
        # Read message
        $msgBytes = New-Object byte[] $length
        $read = $stdin.Read($msgBytes, 0, $length)
        if ($read -ne $length) { break }
        
        $json = [System.Text.Encoding]::UTF8.GetString($msgBytes)
        $msg = $json | ConvertFrom-Json
        
        Log "Received: $json"
        
        if ($msg.type -eq 'SET_ENABLED') {
            $enabled = $msg.enabled
            Log "Setting enabled state to: $enabled"
            
            # Save to config
            $config = @{ enabled = $enabled }
            $config | ConvertTo-Json | Out-File -FilePath $configFile
            
            $startupFolder = [System.IO.Path]::Combine($env:APPDATA, "Microsoft\Windows\Start Menu\Programs\Startup")
            $shortcutPath = [System.IO.Path]::Combine($startupFolder, "JRMResetTimer.lnk")
            $helperPath = Join-Path $PSScriptRoot "..\windows-helper\ResetTimerStartup.ps1"
            $helperPath = [System.IO.Path]::GetFullPath($helperPath)

            if ($enabled) {
                Log "Creating Startup Shortcut for $helperPath"
                try {
                    $wshell = New-Object -ComObject WScript.Shell
                    $shortcut = $wshell.CreateShortcut($shortcutPath)
                    $shortcut.TargetPath = "powershell.exe"
                    $shortcut.Arguments = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$helperPath`""
                    $shortcut.WindowStyle = 7 # Minimized/Hidden
                    $shortcut.Save()
                    Log "Startup shortcut created successfully."
                } catch {
                    Log "CRITICAL: Failed to create shortcut: $_"
                }
            } else {
                Log "Removing Startup Shortcut..."
                if (Test-Path $shortcutPath) {
                    Remove-Item $shortcutPath -Force
                    Log "Startup shortcut removed."
                }
            }
            
            Send-Message @{ status = "ok"; enabled = $enabled }
        }
        elseif ($msg.type -eq 'CONTENT_RESULT') {
            Log "Result from content script: $($msg.success)"
            Send-Message @{ status = "logged" }
        }
        else {
            Send-Message @{ error = "Unknown message type" }
        }
    }
}
catch {
    Log "Error: $_"
}
finally {
    Log "Host exiting."
}
