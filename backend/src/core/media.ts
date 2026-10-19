// Servidor de video.
// Local: MediaMTX recibe WebRTC (WHIP) desde el navegador, lo reparte por WebRTC (WHEP) y HLS
//        y graba a disco. Cada petición de emitir o ver pasa por /internal/media/auth.
// AWS:   Amazon IVS. La interfaz expone lo mismo que IVS: URL de emisión, URL de reproducción
//        con token firmado, estado del canal y archivos grabados.
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { Config } from '../config.js';
import { HttpError } from './http.js';

export interface PathState {
  publishing: boolean;
  viewers: number;
}

export interface MediaServer {
  publishUrl(path: string, token: string): string;
  playUrls(path: string, token: string): { webrtc: string; hls: string };
  state(path: string): Promise<PathState>;
  recordingFiles(path: string): Promise<string[]>;
}

export class MediaMtx implements MediaServer {
  constructor(private cfg: Config) {}

  publishUrl(path: string, token: string) {
    return `${this.cfg.media.publicWebrtcUrl}/${path}/whip?token=${encodeURIComponent(token)}`;
  }

  playUrls(path: string, token: string) {
    const t = encodeURIComponent(token);
    return {
      webrtc: `${this.cfg.media.publicWebrtcUrl}/${path}/whep?token=${t}`,
      hls: `${this.cfg.media.publicHlsUrl}/${path}/index.m3u8?token=${t}`,
    };
  }

  async state(path: string): Promise<PathState> {
    const res = await fetch(`${this.cfg.media.apiUrl}/v3/paths/get/${path}`);
    if (res.status === 404) return { publishing: false, viewers: 0 };
    if (!res.ok) throw new Error(`MediaMTX respondió ${res.status}`);
    const body = (await res.json()) as { ready?: boolean; readers?: unknown[] };
    return { publishing: !!body.ready, viewers: body.readers?.length ?? 0 };
  }

  async recordingFiles(path: string) {
    const dir = join(this.cfg.media.recordingsDir, path);
    try {
      const names = (await readdir(dir)).filter((n) => n.endsWith('.mp4')).sort();
      const files: string[] = [];
      for (const n of names) {
        const full = join(dir, n);
        if ((await stat(full)).size > 0) files.push(full);
      }
      return files;
    } catch {
      return [];
    }
  }
}

/** Marcador para AWS mientras no exista el adaptador de Amazon IVS: el resto de la app funciona. */
export class MediaNotConfigured implements MediaServer {
  private fail(): never {
    throw new HttpError(501, 'El video en AWS (Amazon IVS) aún no está conectado', 'not_implemented');
  }
  publishUrl(): string {
    return this.fail();
  }
  playUrls(): { webrtc: string; hls: string } {
    return this.fail();
  }
  async state() {
    return { publishing: false, viewers: 0 };
  }
  async recordingFiles() {
    return [];
  }
}
