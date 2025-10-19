// In worker/src/services/audio.service.ts
import { exec } from 'child_process';

// The "contract" for any audio processor
export interface IAudioService {
  extractAudio(videoPath: string, audioPath: string): Promise<void>;
}

// The specific implementation using FFmpeg
export class FfmpegAudioService implements IAudioService {
  private runCommand(command: string): Promise<void> {
    return new Promise((resolve, reject) => {
      exec(command, (error, stdout, stderr) => {
        if (error) {
          console.error(`FFmpeg Error: ${stderr}`);
          return reject(error);
        }
        resolve();
      });
    });
  }

  async extractAudio(videoPath: string, audioPath: string): Promise<void> {
    const ffmpegCommand = `ffmpeg -i ${videoPath} -vn -acodec libmp3lame -q:a 2 ${audioPath}`;
    console.log(`[FfmpegAudioService] Running: ${ffmpegCommand}`);
    await this.runCommand(ffmpegCommand);
    console.log(`[FfmpegAudioService] Audio extracted to ${audioPath}`);
  }
}