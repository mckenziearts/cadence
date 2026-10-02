// 16-bit PCM WAV, the format Piper writes and the voice-over track uses.
import fs from 'node:fs/promises';

export interface Pcm {
  sampleRate: number;
  /** Mono samples (the first channel of a multichannel file). */
  samples: Int16Array;
}

interface Layout {
  sampleRate: number;
  channels: number;
  dataOffset: number;
  dataBytes: number;
}

/** Walks the RIFF chunks of `head` (at least the bytes up to the data chunk); `fileSize` caps the data length. */
function layout(head: Buffer, fileSize: number): Layout {
  if (head.toString('ascii', 0, 4) !== 'RIFF' || head.toString('ascii', 8, 12) !== 'WAVE') throw new Error('not a WAV file');
  let format: { code: number; channels: number; sampleRate: number; bits: number } | null = null;
  let offset = 12;
  while (offset + 8 <= head.length) {
    const id = head.toString('ascii', offset, offset + 4);
    const size = head.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === 'fmt ') {
      format = {
        code: head.readUInt16LE(body),
        channels: head.readUInt16LE(body + 2),
        sampleRate: head.readUInt32LE(body + 4),
        bits: head.readUInt16LE(body + 14),
      };
    } else if (id === 'data') {
      if (!format || format.code !== 1 || format.bits !== 16) throw new Error('not 16-bit PCM');
      return {
        sampleRate: format.sampleRate,
        channels: format.channels,
        dataOffset: body,
        dataBytes: Math.min(size, fileSize - body),
      };
    }
    offset = body + size + (size % 2);
  }
  throw new Error('no data chunk');
}

/** Length in seconds, from the header only. */
export async function wavSeconds(file: string): Promise<number> {
  const handle = await fs.open(file, 'r');
  try {
    const { size } = await handle.stat();
    const head = Buffer.alloc(Math.min(size, 4096));
    await handle.read(head, 0, head.length, 0);
    const { sampleRate, channels, dataBytes } = layout(head, size);
    return dataBytes / 2 / channels / sampleRate;
  } finally {
    await handle.close();
  }
}

export function readWav(data: Buffer): Pcm {
  const { sampleRate, channels, dataOffset, dataBytes } = layout(data, data.length);
  const frames = Math.floor(dataBytes / 2 / channels);
  const samples = new Int16Array(frames);
  for (let i = 0; i < frames; i++) samples[i] = data.readInt16LE(dataOffset + i * channels * 2);
  return { sampleRate, samples };
}

export function writeWav({ sampleRate, samples }: Pcm): Buffer {
  const out = Buffer.alloc(44 + samples.length * 2);
  out.write('RIFF', 0, 'ascii');
  out.writeUInt32LE(36 + samples.length * 2, 4);
  out.write('WAVEfmt ', 8, 'ascii');
  out.writeUInt32LE(16, 16);
  out.writeUInt16LE(1, 20);
  out.writeUInt16LE(1, 22);
  out.writeUInt32LE(sampleRate, 24);
  out.writeUInt32LE(sampleRate * 2, 28);
  out.writeUInt16LE(2, 32);
  out.writeUInt16LE(16, 34);
  out.write('data', 36, 'ascii');
  out.writeUInt32LE(samples.length * 2, 40);
  for (let i = 0; i < samples.length; i++) out.writeInt16LE(samples[i], 44 + i * 2);
  return out;
}
