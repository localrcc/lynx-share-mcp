import { open } from 'node:fs/promises';
import { localFile, object, string, number } from './music.mjs';

async function wave(file, consume) {
  file = localFile(file, ['.wav']);
  const fd = await open(file, 'r');
  try {
    const { size } = await fd.stat();
    async function read(offset, length) {
      const buffer = Buffer.alloc(length);
      if ((await fd.read(buffer, 0, length, offset)).bytesRead !== length) throw new Error('Truncated WAV file');
      return buffer;
    }
    const head = await read(0, 12);
    if (head.toString('ascii', 0, 4) !== 'RIFF' || head.toString('ascii', 8) !== 'WAVE')
      throw new Error('Expected a RIFF WAV file');
    const end = Math.min(size, head.readUInt32LE(4) + 8);
    let fmt, data;
    for (let at = 12; at + 8 <= end;) {
      const chunk = await read(at, 8);
      const length = chunk.readUInt32LE(4);
      if (at + 8 + length > end) throw new Error('Truncated WAV chunk');
      const id = chunk.toString('ascii', 0, 4);
      if (id === 'fmt ' && length >= 16) fmt = await read(at + 8, Math.min(length, 40));
      if (id === 'data') data = { offset: at + 8, length };
      if (fmt && data) break;
      at += 8 + length + (length & 1);
    }
    if (!fmt || !data) throw new Error('WAV is missing format or audio data');
    const tag = fmt.readUInt16LE(0);
    const format = tag === 65534 && fmt.length >= 40 ? fmt.readUInt16LE(24) : tag;
    const channels = fmt.readUInt16LE(2), rate = fmt.readUInt32LE(4);
    const bits = fmt.readUInt16LE(14), bytes = bits / 8;
    const frameSize = fmt.readUInt16LE(12);
    if (!channels || channels > 32 || rate < 1000 || rate > 768000 || frameSize !== channels * bytes ||
        !(format === 1 && [8, 16, 24, 32].includes(bits) || format === 3 && [32, 64].includes(bits)))
      throw new Error('Unsupported WAV format. Use PCM or IEEE float WAV.');
    const frames = Math.floor(data.length / frameSize);
    if (!frames) throw new Error('WAV has no audio frames');
    const sample = format === 3
      ? (b, i) => bits === 32 ? b.readFloatLE(i) : b.readDoubleLE(i)
      : (b, i) => bits === 8 ? (b[i] - 128) / 128 : b.readIntLE(i, bytes) / 2 ** (bits - 1);
    return await consume({ channels, rate, bits, frames, frameSize, bytes, sample,
      fullScale: format === 1 ? 1 - 2 ** (1 - bits) : 1,
      readFrames: (start, count) => read(data.offset + start * frameSize, count * frameSize) });
  } finally {
    await fd.close();
  }
}

const db = value => value > 0 ? Math.round(2000 * Math.log10(value)) / 100 : null;

async function analyze({ audio }) {
  return wave(audio, async w => {
    const stats = Array.from({ length: w.channels }, () => ({ peak: 0, squares: 0, fullScale: 0 }));
    let quietFrames = 0, nonFinite = 0, stereoProduct = 0;
    for (let start = 0; start < w.frames; start += 16384) {
      const count = Math.min(16384, w.frames - start);
      const block = await w.readFrames(start, count);
      for (let frame = 0; frame < count; frame++) {
        let framePeak = 0, left = 0;
        for (let c = 0; c < w.channels; c++) {
          const sample = w.sample(block, frame * w.frameSize + c * w.bytes);
          if (!Number.isFinite(sample)) { nonFinite++; continue; }
          const magnitude = Math.abs(sample);
          const s = stats[c];
          s.peak = Math.max(s.peak, magnitude);
          s.squares += sample * sample;
          if (magnitude >= w.fullScale) s.fullScale++;
          framePeak = Math.max(framePeak, magnitude);
          if (c === 0) left = sample;
          if (c === 1 && w.channels === 2) stereoProduct += left * sample;
        }
        if (framePeak < 0.001) quietFrames++;
      }
    }
    const stereoEnergy = w.channels === 2 ? Math.sqrt(stats[0].squares * stats[1].squares) : 0;
    return { durationSeconds: w.frames / w.rate, sampleRate: w.rate, bitDepth: w.bits,
      nearSilencePercent: Math.round(10000 * quietFrames / w.frames) / 100, nonFiniteSamples: nonFinite,
      stereoCorrelation: stereoEnergy ? Math.max(-1, Math.min(1, stereoProduct / stereoEnergy)) : null,
      channels: stats.map(({ peak, squares, fullScale }, index) =>
        ({ channel: index + 1, samplePeakDbfs: db(peak), rmsDbfs: db(Math.sqrt(squares / w.frames)), fullScaleSamples: fullScale })) };
  });
}

async function preview({ audio, start = 0, seconds = 5 }) {
  return wave(audio, async w => {
    const from = Math.floor(start * w.rate);
    if (from >= w.frames) throw new Error('Preview starts after the end of the WAV');
    const count = Math.min(w.frames - from, Math.floor(seconds * w.rate));
    const rate = Math.min(16000, w.rate);
    const frames = Math.floor(count * rate / w.rate);
    if (!frames) throw new Error('Preview range is too short');
    const output = Buffer.alloc(44 + frames * 2);
    output.write('RIFF', 0); output.writeUInt32LE(output.length - 8, 4);
    output.write('WAVEfmt ', 8); output.writeUInt32LE(16, 16);
    output.writeUInt16LE(1, 20); output.writeUInt16LE(1, 22);
    output.writeUInt32LE(rate, 24); output.writeUInt32LE(rate * 2, 28);
    output.writeUInt16LE(2, 32); output.writeUInt16LE(16, 34);
    output.write('data', 36); output.writeUInt32LE(frames * 2, 40);
    for (let i = 0; i < frames; i += 1024) {
      const stop = Math.min(frames, i + 1024);
      const first = Math.floor(i * w.rate / rate);
      const block = await w.readFrames(from + first, Math.floor(stop * w.rate / rate) - first);
      for (let j = i; j < stop; j++) {
        const a = Math.floor(j * w.rate / rate) - first, b = Math.floor((j + 1) * w.rate / rate) - first;
        let sum = 0;
        for (let frame = a; frame < b; frame++)
          for (let c = 0; c < w.channels; c++) {
            const value = w.sample(block, frame * w.frameSize + c * w.bytes);
            if (Number.isFinite(value)) sum += value;
          }
        output.writeInt16LE(Math.round(32767 * Math.max(-1, Math.min(1, sum / ((b - a) * w.channels)))), 44 + j * 2);
      }
    }
    return { content: [
      { type: 'text', text: 'Mono WAV preview. Use lynx_analyze_audio for the original channel measurements.' },
      { type: 'audio', mimeType: 'audio/wav', data: output.toString('base64') }
    ] };
  });
}

export const audio = {
  lynx_analyze_audio: ['Measure WAV duration, peak, RMS, full-scale samples, near silence and stereo correlation',
    object({ audio: string }), analyze],
  lynx_preview_audio: ['Return a short playable WAV excerpt as MCP audio content',
    object({ audio: string, start: number(0, 86400), seconds: number(0.25, 8) }, ['audio']), preview]
};
