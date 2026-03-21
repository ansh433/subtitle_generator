// worker/src/processors/transcribe.processor.ts

import path from 'path';
import { IJobProcessor, JobData } from '../interfaces/job-processor.interface.js';
import { IStorageService } from '../services/storage/storage.interface.js';
import { IStateService } from '../services/state/state.interface.js';
import { IFileSystemService } from '../services/filesystem/filesystem.interface.js';
import { ITranscriptionService, TranscriptSegment } from '../services/transcription.service.js';
import { IAudioService } from '../services/audio.service.js';

export class TranscribeProcessor implements IJobProcessor {
  constructor(
    private storageService: IStorageService,
    private stateService: IStateService,
    private fileSystemService: IFileSystemService,
    private audioService: IAudioService,
    private transcriptionService: ITranscriptionService
  ) {}

  async process(jobData: JobData): Promise<string> {
    const { jobId, videoUrl } = jobData;
    let tempDir = '';

    try {
      // Create workspace
      tempDir = await this.createWorkspace(jobId);
      
      // Execute pipeline steps with checkpointing
      const audioS3Key = await this.ensureAudioExtracted(jobId, videoUrl, tempDir);
      const transcript = await this.ensureTranscribed(jobId, audioS3Key);
      const srtS3Key = await this.generateAndUploadSrt(jobId, videoUrl, transcript, tempDir);
      
      return srtS3Key;
      
    } finally {
      // Always cleanup temp files
      if (tempDir) {
        await this.fileSystemService.cleanup(tempDir);
      }
    }
  }

  /**
   * Step 1: Create temporary working directory
   */
  private async createWorkspace(jobId: string): Promise<string> {
    console.log(`[${jobId}] Creating workspace`);
    return await this.fileSystemService.createTempDir(jobId);
  }

  /**
   * Step 2: Download video and extract audio (with checkpoint)
   * If audio already exists in S3 (from previous failed attempt), skip extraction
   */
  private async ensureAudioExtracted(
    jobId: string,
    videoUrl: string,
    tempDir: string
  ): Promise<string> {
    // Check checkpoint first
    const checkpoint = await this.stateService.getCheckpoint(jobId);
    
    if (checkpoint?.audioS3Key) {
      console.log(`[${jobId}] Audio already extracted: ${checkpoint.audioS3Key}`);
      return checkpoint.audioS3Key;
    }

    // No checkpoint - do the work
    await this.stateService.updateStatus(jobId, 'processing:downloading_video');
    
    const videoPath = await this.downloadVideo(videoUrl, tempDir);
    const audioPath = await this.extractAudio(jobId, videoPath, tempDir);
    const audioS3Key = await this.uploadAudio(audioPath, videoUrl);
    
    // Save checkpoint
    await this.stateService.saveCheckpoint(jobId, { audioS3Key });
    
    return audioS3Key;
  }

  /**
   * Download video from storage to local disk
   */
  private async downloadVideo(videoUrl: string, tempDir: string): Promise<string> {
    const localPath = path.join(tempDir, path.basename(videoUrl));
    await this.storageService.download(videoUrl, localPath);
    return localPath;
  }

  /**
   * Extract audio from video using FFmpeg
   */
  private async extractAudio(jobId: string, videoPath: string, tempDir: string): Promise<string> {
    await this.stateService.updateStatus(jobId, 'processing:extracting_audio');
    
    const audioPath = path.join(tempDir, `${path.parse(videoPath).name}.mp3`);
    await this.audioService.extractAudio(videoPath, audioPath);
    
    return audioPath;
  }

  /**
   * Upload extracted audio to storage
   */
  private async uploadAudio(audioPath: string, originalVideoUrl: string): Promise<string> {
    const audioS3Key = `${path.parse(originalVideoUrl).name}.mp3`;
    await this.storageService.upload(audioPath, audioS3Key, 'audio/mpeg');
    return audioS3Key;
  }

  /**
   * Step 3: Transcribe audio (with checkpoint)
   * If transcript JSON already cached, skip API call
   */
  private async ensureTranscribed(jobId: string, audioS3Key: string): Promise<TranscriptSegment[]> {
    // Check checkpoint first
    const checkpoint = await this.stateService.getCheckpoint(jobId);
    
    if (checkpoint?.transcriptJson) {
      console.log(`[${jobId}] Using cached transcript`);
      return JSON.parse(checkpoint.transcriptJson) as TranscriptSegment[];
    }

    // No checkpoint - call transcription API
    await this.stateService.updateStatus(jobId, 'processing:transcribing_audio');
    
    const transcript = await this.transcriptionService.transcribe(audioS3Key);
    
    if (!transcript || transcript.length === 0) {
      throw new Error('Transcription returned no segments');
    }

    // Save checkpoint (avoid re-paying for API call)
    await this.stateService.saveCheckpoint(jobId, {
      transcriptJson: JSON.stringify(transcript)
    });
    
    return transcript;
  }

  /**
   * Step 4: Format transcript to SRT and upload
   */
  private async generateAndUploadSrt(
    jobId: string,
    videoUrl: string,
    transcript: TranscriptSegment[],
    tempDir: string
  ): Promise<string> {
    // Format to SRT
    const srtContent = this.formatToSrt(transcript);
    
    // Write to temp file
    const srtPath = path.join(tempDir, `${path.parse(videoUrl).name}.srt`);
    await this.fileSystemService.writeFile(srtPath, srtContent);
    
    // Upload to storage
    const srtS3Key = `${path.parse(videoUrl).name}.srt`;
    await this.storageService.upload(srtPath, srtS3Key, 'application/x-subrip');
    
    // Save to job state
    await this.stateService.saveOutput(jobId, srtS3Key);
    
    return srtS3Key;
  }

  /**
   * Convert transcript segments to SRT format
   */
  private formatToSrt(transcript: TranscriptSegment[]): string {
    const toTimestamp = (ms: number) =>
      new Date(ms).toISOString().substr(11, 12);
    
    return transcript
      .map(
        (entry, index) =>
          `${index + 1}\n${toTimestamp(entry.start)} --> ${toTimestamp(
            entry.end
          )}\n${entry.text}\n`
      )
      .join('\n');
  }
}