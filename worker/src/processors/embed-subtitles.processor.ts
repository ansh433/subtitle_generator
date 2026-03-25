import { IJobProcessor, JobData } from '../interfaces/job-processor.interface.js';
import { IStorageService } from '../services/storage/storage.interface.js';
import { IStateService } from '../services/state/state.interface.js';
import { IFileSystemService } from '../services/filesystem/filesystem.interface.js';
import { exec } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import fs from 'fs/promises';

const execAsync = promisify(exec);

export class EmbedSubtitlesProcessor implements IJobProcessor {
  constructor(
    private storage: IStorageService,
    private state: IStateService,
    private filesystem: IFileSystemService
  ) {}

  async process(job: JobData): Promise<string> {
    const { jobId, videoUrl, subtitleUrl } = job;
    
    if (!videoUrl || !subtitleUrl) {
      throw new Error('Both videoUrl and subtitleUrl are required for embed job');
    }

    const workDir = `/tmp/${jobId}`;
    await fs.mkdir(workDir, { recursive: true });

    try {
      // 1. Download video to a SAFE, spaceless filename
      await this.state.updateStatus(jobId, 'processing:downloading_video');
      const safeVideoPath = path.join(workDir, 'input_video.mp4');
      await this.storage.download(videoUrl, safeVideoPath);

      // 2. Download subtitle to a SAFE, spaceless filename
      await this.state.updateStatus(jobId, 'processing:downloading_subtitle');
      const safeSubtitlePath = path.join(workDir, 'subs.srt');
      await this.storage.download(subtitleUrl, safeSubtitlePath);

      // 3. Embed subtitles using FFmpeg with safe paths
      await this.state.updateStatus(jobId, 'processing:embedding_subtitles');
      const safeOutputPath = path.join(workDir, 'output_video.mp4');
      
      // Because we use 'subs.srt', we don't have to worry about FFmpeg space-escaping nightmares
      const ffmpegCommand = `ffmpeg -nostdin -y -i "${safeVideoPath}" -vf "subtitles='${safeSubtitlePath}':force_style='FontSize=24,PrimaryColour=&HFFFFFF'" -c:a copy "${safeOutputPath}"`;
      
      console.log(`[EmbedSubtitlesProcessor] Running: ${ffmpegCommand}`);
      
      try {
        const { stdout, stderr } = await execAsync(ffmpegCommand, { maxBuffer: 1024 * 1024 * 50 });
        console.log(`[EmbedSubtitlesProcessor] FFmpeg stdout:`, stdout);
        console.log(`[EmbedSubtitlesProcessor] FFmpeg stderr:`, stderr);
      } catch (error: any) {
        console.error(`[EmbedSubtitlesProcessor] FFmpeg failed:`, error);
        throw new Error(`FFmpeg subtitle embedding failed: ${error.message}`);
      }

      // 4. Upload result using the original intended name for S3
      await this.state.updateStatus(jobId, 'processing:uploading_result');
      const outputKey = `embedded-${path.basename(videoUrl)}`;
      await this.storage.upload(safeOutputPath, outputKey, 'video/mp4');

      // Update job with result URL
      await this.state.updateStatus(jobId, 'completed');
      
      const redis = (this.state as any).redisClient || (this.state as any).client || (this.state as any).redis;
      if (!redis) {
        throw new Error("Could not locate Redis client on StateService.");
      }
      
      await redis.hSet(`job:${jobId}`, 'embeddedVideoUrl', outputKey);
      
      console.log(`[${jobId}] Embed subtitles completed successfully`);
      
      return outputKey;
    } finally {
      await this.filesystem.cleanup(workDir);
    }
  }
}