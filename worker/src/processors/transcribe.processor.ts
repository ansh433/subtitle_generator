import path from 'path';
import { IJobProcessor, JobData } from '../interfaces/job-processor.interface.js';
import { IStorageService } from '../services/storage/storage.interface.js';
import { IStateService } from '../services/state/state.interface.js';
import { IFileSystemService } from '../services/filesystem/filesystem.interface.js';
import { ITranscriptionService } from '../services/transcription.service.js';
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
      const srtContent = await this.ensureTranscribed(jobId, audioS3Key);
      const srtS3Key = await this.generateAndUploadSrt(jobId, videoUrl, srtContent, tempDir);
      
      return srtS3Key;
      
    } finally {
      // Always cleanup temp files
      if (tempDir) {
        await this.fileSystemService.cleanup(tempDir);
      }
    }
  }

  private async createWorkspace(jobId: string): Promise<string> {
    console.log(`[${jobId}] Creating workspace`);
    return await this.fileSystemService.createTempDir(jobId);
  }

  private async ensureAudioExtracted(
    jobId: string,
    videoUrl: string,
    tempDir: string
  ): Promise<string> {
    const checkpoint = await this.stateService.getCheckpoint(jobId);
    
    if (checkpoint?.audioS3Key) {
      console.log(`[${jobId}] Audio already extracted: ${checkpoint.audioS3Key}`);
      return checkpoint.audioS3Key;
    }

    await this.stateService.updateStatus(jobId, 'processing:downloading_video');
    
    const videoPath = await this.downloadVideo(videoUrl, tempDir);
    const audioPath = await this.extractAudio(jobId, videoPath, tempDir);
    const audioS3Key = await this.uploadAudio(audioPath, videoUrl);
    
    await this.stateService.saveCheckpoint(jobId, { audioS3Key });
    
    return audioS3Key;
  }

  private async downloadVideo(videoUrl: string, tempDir: string): Promise<string> {
    const localPath = path.join(tempDir, path.basename(videoUrl));
    await this.storageService.download(videoUrl, localPath);
    return localPath;
  }

  private async extractAudio(jobId: string, videoPath: string, tempDir: string): Promise<string> {
    await this.stateService.updateStatus(jobId, 'processing:extracting_audio');
    
    const audioPath = path.join(tempDir, `${path.parse(videoPath).name}.mp3`);
    await this.audioService.extractAudio(videoPath, audioPath);
    
    return audioPath;
  }

  private async uploadAudio(audioPath: string, originalVideoUrl: string): Promise<string> {
    const audioS3Key = `${path.parse(originalVideoUrl).name}.mp3`;
    await this.storageService.upload(audioPath, audioS3Key, 'audio/mpeg');
    return audioS3Key;
  }

  private async ensureTranscribed(jobId: string, audioS3Key: string): Promise<string> {
    const checkpoint = await this.stateService.getCheckpoint(jobId);
    
    // Check for cached SRT string
    if (checkpoint?.transcriptSrt) {
      console.log(`[${jobId}] Using cached transcript SRT`);
      return checkpoint.transcriptSrt;
    }

    await this.stateService.updateStatus(jobId, 'processing:transcribing_audio');
    
    // Now returns a fully formatted SRT string
    const srtContent = await this.transcriptionService.transcribe(audioS3Key);
    
    if (!srtContent || srtContent.trim() === '') {
      throw new Error('Transcription returned an empty string');
    }

    // Save checkpoint as a raw string
    await this.stateService.saveCheckpoint(jobId, {
      transcriptSrt: srtContent
    });
    
    return srtContent;
  }

  private async generateAndUploadSrt(
    jobId: string,
    videoUrl: string,
    srtContent: string,
    tempDir: string
  ): Promise<string> {
    // Write directly to temp file
    const srtPath = path.join(tempDir, `${path.parse(videoUrl).name}.srt`);
    await this.fileSystemService.writeFile(srtPath, srtContent);
    
    // Upload to storage
    const srtS3Key = `${path.parse(videoUrl).name}.srt`;
    await this.storageService.upload(srtPath, srtS3Key, 'application/x-subrip');
    
    // Save to job state
    await this.stateService.saveOutput(jobId, srtS3Key);
    
    return srtS3Key;
  }
}