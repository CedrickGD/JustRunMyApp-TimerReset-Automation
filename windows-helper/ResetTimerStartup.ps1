$configPath = Join-Path $PSScriptRoot "..\native-host\config.json"
$urlConfigPath = Join-Path $PSScriptRoot "config.json"

# Redirect output to a log file for debugging hidden execution
$logPath = Join-Path $PSScriptRoot "startup.log"
function Log($msg) {
    $ts = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    "[$ts] $msg" | Out-File -FilePath $logPath -Append
}

Log "Startup helper triggered."

if (-not (Test-Path $urlConfigPath)) {
    Log "URL config not found at $urlConfigPath. Copy config.example.json to config.json and set targetUrl."
    return
}
$targetUrl = (Get-Content $urlConfigPath -Raw | ConvertFrom-Json).targetUrl
if (-not $targetUrl) {
    Log "config.json is missing 'targetUrl'."
    return
}

if (Test-Path $configPath) {
    $config = Get-Content $configPath | ConvertFrom-Json
    if ($config.enabled) {
        Log "Automation is enabled. Launching browser..."

        # Try to find Comet specifically
        $cometPaths = @(
            "$env:LOCALAPPDATA\Comet\Application\comet.exe",
            "$env:ProgramFiles\Comet\Application\comet.exe",
            "$env:ProgramFiles(x86)\Comet\Application\comet.exe"
        )

        $foundComet = $false
        foreach ($path in $cometPaths) {
            if (Test-Path $path) {
                Log "Found Comet at $path. Launching..."
                Start-Process $path -ArgumentList "`"$targetUrl`" --new-window"
                $foundComet = $true
                break
            }
        }

        if (!$foundComet) {
            Log "Comet not found in standard paths. Falling back to default browser handler."
            Start-Process $targetUrl
        }
    } else {
        Log "Automation is disabled in config. Skipping launch."
    }
} else {
    Log "Native host config file not found at $configPath. Defaulting to disabled."
}
