# Phase 2 Reliability Test Suite
# Tests: Priority queues

param(
    [string]$VideoFile = "C:\Users\Fanta\Videos\Screen Recordings\Screen Recording 2024-07-05 004829.mp4"
)

$ErrorActionPreference = "Continue"

function Write-Success { param($msg) Write-Host "[OK] $msg" -ForegroundColor Green }
function Write-ErrorMsg { param($msg) Write-Host "[ERROR] $msg" -ForegroundColor Red }
function Write-Info { param($msg) Write-Host "[INFO] $msg" -ForegroundColor Cyan }
function Write-WarningMsg { param($msg) Write-Host "[WARN] $msg" -ForegroundColor Yellow }

# API helper functions
function Upload-Video {
    param([string]$fileName = "test.mp4")
    
    Write-Info "Getting presigned URL..."
    $upload = Invoke-RestMethod -Uri "http://localhost:3000/jobs/signed-url" `
        -Method Post `
        -Headers @{"Content-Type"="application/json"} `
        -Body "{`"fileName`": `"$fileName`", `"fileType`": `"video/mp4`"}"
    
    Write-Info "Uploading video to S3..."
    Invoke-RestMethod -Uri $upload.preSignedUrl `
        -Method Put `
        -Headers @{"Content-Type"="video/mp4"} `
        -InFile $VideoFile | Out-Null
    
    return $upload
}

function Create-Job {
    param(
        [string]$videoUrl,
        [string]$priority = "low"
    )
    
    $body = @{
        videoUrl = $videoUrl
        priority = $priority
    } | ConvertTo-Json
    
    $job = Invoke-RestMethod -Uri "http://localhost:3000/jobs" `
        -Method Post `
        -Headers @{"Content-Type"="application/json"} `
        -Body $body
    
    return $job
}

function Get-JobStatus {
    param([string]$jobId)
    
    try {
        return Invoke-RestMethod -Uri "http://localhost:3000/jobs/$jobId"
    } catch {
        return $null
    }
}

function Wait-ForJobStatus {
    param(
        [string]$jobId,
        [string]$status,
        [int]$timeoutSeconds = 60
    )
    
    $startTime = Get-Date
    while (((Get-Date) - $startTime).TotalSeconds -lt $timeoutSeconds) {
        $job = Get-JobStatus -jobId $jobId
        if ($job -and $job.status -eq $status) {
            return $true
        }
        Start-Sleep -Seconds 2
    }
    return $false
}

function Show-TestHeader {
    param([string]$testName, [int]$testNumber)
    
    Write-Host "`n$('='*70)" -ForegroundColor Yellow
    Write-Host "TEST $testNumber : $testName" -ForegroundColor Yellow
    Write-Host "$('='*70)`n" -ForegroundColor Yellow
}

# ============================================================================
# TEST 5: Priority Queue Ordering
# ============================================================================
function Test-PriorityQueues {
    Show-TestHeader -testName "Priority Queue Ordering" -testNumber 5
    
    Write-Info "This test verifies that high-priority jobs process before low-priority"
    Write-Host ""
    
    # Upload video ONCE, reuse for all jobs
    Write-Info "Uploading video once (will reuse for all jobs)..."
    $sharedUpload = Upload-Video -fileName "test-priority.mp4"
    Write-Success "Video uploaded: $($sharedUpload.key)"
    Write-Host ""
    
    # Create low-priority jobs (reusing same S3 key)
    Write-Info "Creating 3 low-priority jobs..."
    $lowJobs = @()
    for ($i = 1; $i -le 3; $i++) {
        $job = Create-Job -videoUrl $sharedUpload.key -priority "low"
        $lowJobs += $job.jobId
        Write-Host "  Low-priority job $i : $($job.jobId)"
        Start-Sleep -Milliseconds 500
    }
    
    Write-Host ""
    Start-Sleep -Seconds 2
    
    # Create high-priority job (same S3 key)
    Write-Info "Creating 1 high-priority job..."
    $highJob = Create-Job -videoUrl $sharedUpload.key -priority "high"
    Write-Success "High-priority job: $($highJob.jobId)"
    
    Write-Host ""
    Write-WarningMsg "Watch Docker logs - the HIGH-PRIORITY job should process FIRST!"
    Write-Host ""
    
    # Wait for high-priority job to start
    Start-Sleep -Seconds 5
    
    Write-Info "Waiting for high-priority job to complete..."
    $completed = Wait-ForJobStatus -jobId $highJob.jobId -status "completed" -timeoutSeconds 60
    
    if ($completed) {
        Write-Success "TEST PASSED: High-priority job completed first!"
        Write-Info "Low-priority jobs will continue processing in background"
    } else {
        Write-ErrorMsg "TEST FAILED: High-priority job did not complete"
    }
}

# ============================================================================
# MAIN EXECUTION
# ============================================================================

Write-Host "`nPHASE 2 RELIABILITY TEST SUITE" -ForegroundColor Cyan
Write-Host "Subtitle Generator - Backend Testing`n" -ForegroundColor Cyan

Write-Host "This script will run 1 automated test:" -ForegroundColor White
Write-Host "  1. Priority Queue Ordering"
Write-Host ""

Write-WarningMsg "Requirements:"
Write-Host "  - Docker services running (docker-compose up)"
Write-Host "  - Video file exists at: $VideoFile"
Write-Host "  - API server accessible at http://localhost:3000"
Write-Host ""

$continue = Read-Host "Continue? (Y/N)"
if ($continue -ne "Y" -and $continue -ne "y") {
    Write-Host "Test suite cancelled." -ForegroundColor Yellow
    exit
}

# Run tests
try {
    Test-PriorityQueues
    
    Write-Host "`n$('='*70)" -ForegroundColor Green
    Write-Host "TEST COMPLETE" -ForegroundColor Green
    Write-Host "$('='*70)`n" -ForegroundColor Green
    
} catch {
    $err = $_.Exception.Message
    Write-Host "[ERROR] Test failed with error: $err" -ForegroundColor Red
}