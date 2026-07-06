/**
 * Minimal canonical 44-byte RIFF/WAVE (PCM) header.
 *
 * The receive path decodes Opus into raw little-endian signed-16-bit PCM, which
 * a headerless `.pcm` file cannot advertise. faster-whisper-server / speaches
 * decode uploads through libav, which cannot autodetect format-less PCM, so each
 * speaker track is written as a real WAV: we reserve these 44 bytes at the head
 * of the file and patch in the true sizes once the data length is known at
 * finalize. Pure and deterministic — only the byte layout, no I/O.
 */

/** Byte length of the canonical PCM WAV header this module writes. */
export const WAV_HEADER_BYTES = 44;

export interface WavFormat {
  sampleRate: number;
  channels: number;
  bytesPerSample: number;
}

/**
 * Build the canonical 44-byte header for `dataBytes` of PCM audio. Callers reserve
 * this many bytes up front (with a zero-filled placeholder) and overwrite it with
 * the real header once `dataBytes` is known.
 */
export function buildWavHeader(dataBytes: number, fmt: WavFormat): Buffer {
  const { sampleRate, channels, bytesPerSample } = fmt;
  const blockAlign = channels * bytesPerSample;
  const byteRate = sampleRate * blockAlign;

  const header = Buffer.alloc(WAV_HEADER_BYTES);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + dataBytes, 4); // RIFF chunk size = 36 + data
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16); // fmt chunk size (PCM)
  header.writeUInt16LE(1, 20); // audio format = PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bytesPerSample * 8, 34); // bits per sample
  header.write("data", 36, "ascii");
  header.writeUInt32LE(dataBytes, 40);
  return header;
}
