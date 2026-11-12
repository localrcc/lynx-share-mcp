import { readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const integer = (minimum, maximum) => ({ type: 'integer', minimum, maximum });
export const number = (minimum, maximum) => ({ type: 'number', minimum, maximum });
export const object = (properties, required = Object.keys(properties)) =>
  ({ type: 'object', properties, required, additionalProperties: false });
export const string = { type: 'string', minLength: 1, maxLength: 32767 };
export const array = (items, maxItems) => ({ type: 'array', items, maxItems });
const index = integer(0, 100000);
const tick = integer(0, 100000000);
const length = integer(1, 100000000);
const pitch = integer(0, 127);
const velocity = number(0.01, 1);
const tempo = number(20, 999);
const label = { type: 'string', minLength: 1, maxLength: 120 };

export function validate(value, schema, where = 'arguments') {
  const type = Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value;
  if (schema.type === 'integer' ? !Number.isInteger(value) : type !== schema.type)
    throw new Error(where + ' must be ' + schema.type);
  if (schema.enum && !schema.enum.includes(value)) throw new Error(where + ' has an unsupported value');
  if (type === 'number' && (!Number.isFinite(value) || value < schema.minimum || value > schema.maximum))
    throw new Error(where + ' must be between ' + schema.minimum + ' and ' + schema.maximum);
  if (type === 'string' && (value.length < schema.minLength || value.length > schema.maxLength))
    throw new Error(where + ' has an invalid length');
  if (type === 'array') {
    if (value.length > schema.maxItems) throw new Error(where + ' has too many items');
    value.forEach((item, i) => validate(item, schema.items, where + '[' + i + ']'));
  }
  if (type === 'object') {
    for (const key of schema.required)
      if (!Object.hasOwn(value, key)) throw new Error(where + '.' + key + ' is required');
    for (const [key, item] of Object.entries(value)) {
      if (!Object.hasOwn(schema.properties, key)) throw new Error(where + '.' + key + ' is unsupported');
      validate(item, schema.properties[key], where + '.' + key);
    }
  }
}

export function localFile(value, extensions) {
  if (!/^[a-z]:[\\/]/i.test(value) || /[:*?"<>|\x00-\x1f]/.test(value.slice(2)) ||
      !extensions.includes(path.extname(value).toLowerCase()))
    throw new Error('Expected an absolute Windows file path ending in ' + extensions.join(', '));
  return path.normalize(value);
}

async function load(project) {
  const file = localFile(project, ['.lynx']);
  if ((await stat(file)).size > 64 * 1024 * 1024) throw new Error('Project exceeds 64 MiB');
  const song = JSON.parse((await readFile(file, 'utf8')).replace(/^\uFEFF/, ''));
  if (song.format !== 'lynx-project' || song.version !== 1 ||
      !['channels', 'patterns', 'playlist', 'mixer'].every(key => Array.isArray(song[key])))
    throw new Error('Expected a LYNX project in native JSON format version 1');
  return { file, song };
}

const note = object({ start: tick, length, pitch, velocity, channel: index }, ['start', 'length', 'pitch', 'channel']);
const midiNote = object({ start: tick, length, pitch, velocity, channel: integer(1, 16) }, ['start', 'length', 'pitch']);
const clip = object({ track: index, pattern: index, start: tick, length });
const boolean = { type: 'boolean' };
const channelEdit = object({ index, name: label, volume: number(0, 1), pan: number(-1, 1), muted: boolean, mixer: index }, ['index']);
const mixerEdit = object({ index, name: label, volume: number(0, 1), pan: number(-1, 1), muted: boolean, solo: boolean }, ['index']);
const trackIndex = integer(0, 499);
const trackEdit = object({ index: trackIndex, name: label, muted: boolean }, ['index']);
const automationEdit = object({ index, name: label, points: array(object({
  tick, value: number(0, 1), curve: number(-1, 1)
}, ['tick', 'value']), 10000) }, ['index']);
const patternEdit = object({ index, name: label, notes: array(note, 10000), replaceNotes: boolean }, ['index']);

function at(items, i, kind) {
  if (!items?.[i]) throw new Error(kind + ' index ' + i + ' does not exist');
  return items[i];
}

function addNotes(song, notes) {
  return notes.map(n => {
    at(song.channels, n.channel, 'Channel');
    return [n.start, n.length, n.channel, n.pitch, n.velocity ?? 0.8];
  });
}

function editProject(song, args) {
  if (args.bpm !== undefined) song.bpm = args.bpm;
  if (args.swing !== undefined) song.swing = args.swing;
  if (args.beatsPerBar !== undefined) song.beatsPerBar = args.beatsPerBar;
  if (args.mode !== undefined) song.mode = args.mode;
  for (const { index: i, mixer, ...changes } of args.channels ?? []) {
    const channel = at(song.channels, i, 'Channel');
    if (mixer !== undefined) {
      at(song.mixer, mixer, 'Mixer');
      changes.mixer = mixer;
    }
    Object.assign(channel, changes);
  }
  for (const { index: i, ...changes } of args.mixer ?? [])
    Object.assign(at(song.mixer, i, 'Mixer'), changes);
  for (const item of args.newChannels ?? []) {
    at(song.mixer, item.mixer ?? 0, 'Mixer');
    song.channels.push({ volume: 0.8, pan: 0, muted: false, mixer: 0, ...item });
  }
  for (const edit of args.playlistTracks ?? []) {
    song.playlistTracks ??= [];
    let row = song.playlistTracks.find(t => t[0] === edit.index);
    if (!row) {
      row = [edit.index, '', false];
      song.playlistTracks.push(row);
    }
    if (edit.name !== undefined) row[1] = edit.name;
    if (edit.muted !== undefined) row[2] = edit.muted;
  }
  for (const edit of args.automations ?? []) {
    const target = at(song.automations, edit.index, 'Automation');
    if (edit.name !== undefined) target.name = edit.name;
    if (edit.points !== undefined) target.points = [...edit.points].sort((a, b) => a.tick - b.tick)
      .map(p => [p.tick, p.value, p.curve ?? 0]);
  }
  for (const p of args.newPatterns ?? [])
    song.patterns.push({ name: p.name, colour: 'd9534f', notes: addNotes(song, p.notes) });
  for (const p of args.patterns ?? []) {
    const target = at(song.patterns, p.index, 'Pattern');
    if (p.name !== undefined) target.name = p.name;
    if (p.replaceNotes) target.notes = [];
    if (p.notes) target.notes = [...(target.notes ?? []), ...addNotes(song, p.notes)];
  }
  if (args.currentPattern !== undefined) {
    at(song.patterns, args.currentPattern, 'Pattern');
    song.currentPattern = args.currentPattern;
  }
  const removed = new Set(args.removeClips ?? []);
  for (const i of removed) at(song.playlist, i, 'Playlist clip');
  for (const { index: i, track, start, length } of args.moveClips ?? []) {
    if (removed.has(i)) throw new Error('Cannot move and remove the same clip');
    const row = at(song.playlist, i, 'Playlist clip');
    if (track !== undefined) row[1] = track;
    if (start !== undefined) row[2] = start;
    if (length !== undefined) row[3] = length;
  }
  song.playlist = song.playlist.filter((_, i) => !removed.has(i));
  for (const c of args.addClips ?? []) {
    at(song.patterns, c.pattern, 'Pattern');
    song.playlist.push([c.pattern, c.track, c.start, c.length, 0, 0, -1]);
  }
}

function variableLength(n) {
  const bytes = [n & 127];
  while ((n >>= 7)) bytes.unshift((n & 127) | 128);
  return bytes;
}

function midiFile(bpm, ppq, notes) {
  const us = Math.round(60000000 / bpm);
  const events = [[0, 0, [255, 81, 3, us >> 16, (us >> 8) & 255, us & 255]]];
  const ends = new Map();
  for (const n of [...notes].sort((a, b) => a.start - b.start)) {
    const channel = (n.channel ?? 1) - 1;
    const key = channel * 128 + n.pitch;
    if (n.start < (ends.get(key) ?? 0)) throw new Error('Overlapping notes of the same pitch and MIDI channel');
    ends.set(key, n.start + n.length);
    events.push([n.start, 2, [144 | channel, n.pitch, Math.round((n.velocity ?? 0.8) * 127)]],
      [n.start + n.length, 1, [128 | channel, n.pitch, 0]]);
  }
  events.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const data = [];
  let previous = 0;
  for (const [time, , bytes] of events) {
    data.push(...variableLength(time - previous), ...bytes);
    previous = time;
  }
  data.push(0, 255, 47, 0);
  const header = Buffer.from('4d546864000000060000000100004d54726b00000000', 'hex');
  header.writeUInt16BE(ppq, 12);
  header.writeUInt32BE(data.length, 18);
  return Buffer.concat([header, Buffer.from(data)]);
}

export const music = {
  lynx_create_project: ['Create a new empty native LYNX song with a synth, Master and Pattern 1',
    object({ output: string, bpm: tempo, beatsPerBar: integer(1, 32) }, ['output']),
    async ({ output, bpm = 120, beatsPerBar = 4 }) => {
      output = localFile(output, ['.lynx']);
      const song = {
        format: 'lynx-project', version: 1, bpm, beatsPerBar, currentPattern: 0, mode: 'song',
        channels: [{ name: 'Synth', instrument: 'synth', volume: 0.8, pan: 0, muted: false, mixer: 0 }],
        patterns: [{ name: 'Pattern 1', colour: 'd9534f', notes: [] }], playlist: [],
        mixer: [{ name: 'Master', volume: 0.8, pan: 0, muted: false, solo: false, effects: [] }]
      };
      await writeFile(output, JSON.stringify(song, null, 2) + '\n', { flag: 'wx' });
      return { output };
    }],
  lynx_inspect_project: ['Read tempo, channel routing, mixer and pattern summaries from a saved LYNX project',
    object({ project: string }), async ({ project }) => {
      const { song } = await load(project);
      return {
        bpm: song.bpm, beatsPerBar: song.beatsPerBar, ticksPerBeat: 960,
        mode: song.mode, currentPattern: song.currentPattern,
        channels: song.channels.map(({ name, instrument, mixer, muted, volume, pan }, index) =>
          ({ index, name, instrument: typeof instrument === 'string' ? instrument : undefined, mixer, muted, volume, pan })),
        patterns: song.patterns.map((p, index) => ({ index, name: p.name, notes: p.notes?.length ?? 0 })),
        mixer: song.mixer.map(({ name, volume, pan, muted, solo, effects }, index) =>
          ({ index, name, volume, pan, muted, solo, effects: effects?.length ?? 0 })),
        arrangements: song.arrangements?.map(a => a.name), currentArrangement: song.currentArrangement,
        playlistTracks: song.playlistTracks, playlistClips: song.playlist.length,
        automations: song.automations?.map(a => ({ name: a.name, target: a.target, points: a.points?.length }))
      };
    }],
  lynx_read_pattern: ['Read Piano Roll notes from a saved project by zero-based pattern index',
    object({ project: string, pattern: index, offset: index, limit: integer(1, 2000) }, ['project', 'pattern']),
    async ({ project, pattern, offset = 0, limit = 250 }) => {
      const { song } = await load(project);
      const { name, notes = [] } = at(song.patterns, pattern, 'Pattern');
      return { name, ticksPerBeat: 960, offset, total: notes.length,
        columns: ['start', 'length', 'channel', 'pitch', 'velocity'],
        notes: notes.slice(offset, offset + limit) };
    }],
  lynx_read_playlist: ['Read a page of Playlist clips in the saved active arrangement',
    object({ project: string, offset: index, limit: integer(1, 2000) }, ['project']),
    async ({ project, offset = 0, limit = 250 }) => {
      const { song } = await load(project);
      return { offset, total: song.playlist.length, clips: song.playlist.slice(offset, offset + limit)
        .map((row, i) => ({ index: offset + i, track: row[1], pattern: (row[5] ?? 0) === 0 ? row[0] : undefined, kind: row[5] ?? 0, reference: row[6], start: row[2], length: row[3], raw: row })) };
    }],
  lynx_edit_project_copy: ['Write a new LYNX project beside the original. Edit tempo, channels, mixer, patterns, notes and Playlist clips using zero-based indices and 960 ticks per beat.',
    object({ project: string, output: string, bpm: tempo, swing: number(0, 1), beatsPerBar: integer(1, 32), currentPattern: index,
      mode: { type: 'string', enum: ['pattern', 'song'] }, channels: array(channelEdit, 500),
      mixer: array(mixerEdit, 500), playlistTracks: array(trackEdit, 500),
      automations: array(automationEdit, 100),
      newChannels: array(object({ name: label, instrument: { type: 'string', enum: [
        'synth', 'kick', 'snare', 'clap', 'hat', 'boobass', 'minisynth', 'drumpad'
      ] }, mixer: index }, ['name', 'instrument']), 100),
      patterns: array(patternEdit, 500),
      newPatterns: array(object({ name: label, notes: array(note, 10000) }), 100),
      addClips: array(clip, 2000), removeClips: array(index, 2000),
      moveClips: array(object({ index, track: index, start: tick, length }, ['index']), 2000)
    }, ['project', 'output']), async args => {
      const { file, song } = await load(args.project);
      const output = localFile(args.output, ['.lynx']);
      if (path.dirname(file).toLowerCase() !== path.dirname(output).toLowerCase())
        throw new Error('Save the copy beside its source to keep relative sample references');
      editProject(song, args);
      await writeFile(output, JSON.stringify(song, null, 2) + '\n', { flag: 'wx' });
      return { output, patterns: song.patterns.length, playlistClips: song.playlist.length };
    }],
  lynx_create_midi: ['Generate a standard MIDI file for import into LYNX. Specify note starts and lengths in ticks.',
    object({ output: string, bpm: tempo, ppq: integer(24, 32767), notes: array(midiNote, 20000) }, ['output', 'notes']),
    async ({ output, bpm = 120, ppq = 960, notes }) => {
      output = localFile(output, ['.mid', '.midi']);
      await writeFile(output, midiFile(bpm, ppq, notes), { flag: 'wx' });
      return { output, notes: notes.length, bpm, ppq };
    }]
};





