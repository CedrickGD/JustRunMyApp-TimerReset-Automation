$hostName = "com.cedrick.jrmreset"
$manifestPath = Join-Path $PSScriptRoot "com.cedrick.jrmreset.json"

# List of possible registry paths for Chromium-based browsers
$registryPaths = @(
    "HKCU:\Software\Google\Chrome\NativeMessagingHosts\$hostName",
    "HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\$hostName"
)

foreach ($path in $registryPaths) {
    Write-Host "Registering in $path..."
    if (!(Test-Path $path)) {
        New-Item -Path $path -Force | Out-Null
    }
    Set-ItemProperty -Path $path -Name "(Default)" -Value $manifestPath
}

Write-Host "Native host registered successfully."
