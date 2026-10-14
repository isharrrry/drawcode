#Requires -Version 5.1
<#
.SYNOPSIS
    drawcode three-language benchmark.

.DESCRIPTION
    Generates the same sample sources, then runs the full "parse -> IR -> .drawio"
    pipeline through each implementation and measures wall-clock time, including
    process startup, because that is what a user actually experiences.

    Scale parameters and the RNG seed are fixed, so results are reproducible.

.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File bench/run.ps1
    powershell -NoProfile -ExecutionPolicy Bypass -File bench/run.ps1 -Sizes s,m -Langs python -Repeat 5
#>
param(
    [string[]]$Sizes = @('s', 'm', 'l'),
    [string[]]$Langs = @('python', 'typescript', 'dotnet'),
    [int]$Repeat = 3
)

$ErrorActionPreference = 'Stop'
$Repo = Split-Path -Parent $PSScriptRoot
$Gen = Join-Path $Repo 'examples/large/generate.py'

# scale presets: modules / signals per module / funcs per module
$Scale = @{
    s   = @{ modules = 5;  signals = 10; funcs = 6 }
    m   = @{ modules = 10; signals = 10; funcs = 6 }
    l   = @{ modules = 20; signals = 10; funcs = 6 }
    xl  = @{ modules = 40; signals = 10; funcs = 6 }
    xxl = @{ modules = 80; signals = 10; funcs = 6 }
}

# per-implementation invocation; $Files / $Root / $Out are supplied by the runner
$Cmd = @{
    python = {
        param($Files, $Root, $Out)
        $env:PYTHONPATH = Join-Path $Repo 'python/src'
        & python -m drawcode.cli build @Files --root $Root --out $Out
    }
    typescript = {
        param($Files, $Root, $Out)
        & node (Join-Path $Repo 'typescript/bin/drawcode.ts') build @Files --root $Root --out $Out
    }
    dotnet = {
        param($Files, $Root, $Out)
        & dotnet (Join-Path $Repo 'dotnet/src/DrawCode/bin/Release/net10.0/DrawCode.dll') build @Files --root $Root --out $Out
    }
}

function Test-LangReady {
    param([string]$Lang)
    switch ($Lang) {
        'python' { return (Test-Path (Join-Path $Repo 'python/src/drawcode/cli.py')) }
        'typescript' { return (Test-Path (Join-Path $Repo 'typescript/bin/drawcode.ts')) }
        'dotnet' { return (Test-Path (Join-Path $Repo 'dotnet/src/DrawCode/bin/Release/net10.0/DrawCode.dll')) }
    }
    return $false
}

$results = New-Object System.Collections.Generic.List[object]
$tmpOut = Join-Path ([System.IO.Path]::GetTempPath()) 'drawcode-bench.drawio'

foreach ($size in $Sizes) {
    if (-not $Scale.ContainsKey($size)) { throw "unknown size: $size" }
    $cfg = $Scale[$size]
    $dir = Join-Path $Repo "examples/large/_bench_$size"

    Write-Host ""
    Write-Host "=== size=$size modules=$($cfg.modules) ===" -ForegroundColor Cyan
    & python $Gen --modules $cfg.modules --signals $cfg.signals --funcs $cfg.funcs --out $dir | Out-Null

    $files = @(Get-ChildItem $dir -Recurse -Include *.h, *.c | Sort-Object FullName | ForEach-Object { $_.FullName })
    Write-Host "files=$($files.Count)"

    foreach ($lang in $Langs) {
        if (-not (Test-LangReady $lang)) {
            Write-Host ("  {0,-11} SKIP (not built)" -f $lang) -ForegroundColor Yellow
            [void]$results.Add([pscustomobject]@{
                    size = $size; lang = $lang; modules = $cfg.modules
                    files = $files.Count; median_ms = $null; min_ms = $null; ok = $false
                    note = 'not built'
                })
            continue
        }

        $times = @()
        $ok = $true
        $note = ''
        for ($i = 0; $i -lt $Repeat; $i++) {
            $sw = [System.Diagnostics.Stopwatch]::StartNew()
            try {
                & $Cmd[$lang] $files $dir $tmpOut 2>&1 | Out-Null
                if ($LASTEXITCODE -ne 0) { $ok = $false; $note = "exit=$LASTEXITCODE" }
            }
            catch {
                $ok = $false; $note = $_.Exception.Message
            }
            $sw.Stop()
            $times += $sw.Elapsed.TotalMilliseconds
        }
        $sorted = $times | Sort-Object
        $median = $sorted[[int][math]::Floor($sorted.Count / 2)]
        Write-Host ("  {0,-11} median={1,8:N1}ms  min={2,8:N1}ms" -f $lang, $median, $sorted[0])

        [void]$results.Add([pscustomobject]@{
                size = $size; lang = $lang; modules = $cfg.modules
                files = $files.Count; median_ms = [math]::Round($median, 1)
                min_ms = [math]::Round($sorted[0], 1); ok = $ok; note = $note
            })
    }
}

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$outDir = Join-Path $Repo 'bench/results'
New-Item -ItemType Directory -Force -Path $outDir | Out-Null
$jsonPath = Join-Path $outDir "bench-$stamp.json"

$cpu = ''
try { $cpu = (Get-CimInstance Win32_Processor | Select-Object -First 1 -ExpandProperty Name) } catch { $cpu = 'unknown' }

$payload = [pscustomobject]@{
    generated_at = (Get-Date).ToString('o')
    machine      = @{
        os    = [System.Runtime.InteropServices.RuntimeInformation]::OSDescription
        cpu   = $cpu
        cores = [Environment]::ProcessorCount
    }
    toolchain    = @{
        python = (& python --version 2>&1 | Out-String).Trim()
        node   = (& node --version 2>&1 | Out-String).Trim()
        dotnet = (& dotnet --version 2>&1 | Out-String).Trim()
    }
    repeat       = $Repeat
    results      = $results
}
$payload | ConvertTo-Json -Depth 6 | Set-Content -Path $jsonPath -Encoding utf8

Write-Host ""
Write-Host "=== summary (median ms) ===" -ForegroundColor Cyan
$results | Format-Table size, lang, files, median_ms, min_ms, ok, note -AutoSize
Write-Host "written: $jsonPath"
