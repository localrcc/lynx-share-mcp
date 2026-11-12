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

async function writeProjectCopy(file, output, song) {
  output = localFile(output, ['.lynx']);
  if (path.dirname(file).toLowerCase() !== path.dirname(output).toLowerCase())
    throw new Error('Save the copy beside its source to keep relative sample references');
  await writeFile(output, JSON.stringify(song, null, 2) + '\n', { flag: 'wx' });
  return output;
}

const page = { offset: index, limit: integer(1, 1000) };
const metadata = object(Object.fromEntries(
  ['title', 'author', 'genre', 'url', 'comments'].map(key => [key, { type: 'string', maxLength: 4000 }])
), []);

const filePair = { project: string, output: string };
const sampleExtensions = ['.wav', '.flac', '.ogg', '.mp3', '.aiff', '.aif'];

function copyTool(description, fields, mutate, optional = []) {
  const properties = { ...filePair, ...fields };
  return [description, object(properties, Object.keys(properties).filter(key => !optional.includes(key))),
    async args => {
      const { file, song } = await load(args.project);
      const result = await mutate(song, args);
      return { output: await writeProjectCopy(file, args.output, song), ...result };
    }];
}

export const music = {
  lynx_read_channel: ['Read a channel’s instrument, sample, routing and mix settings',
    object({ project: string, channel: index }), async ({ project, channel }) => {
      const { song } = await load(project);
      const { name, instrument, sample, mixer, volume, pan, muted, colour } = at(song.channels, channel, 'Channel');
      return { channel, name, instrument, sample, mixer, volume, pan, muted, colour };
    }],
  lynx_add_sample_channel: copyTool('Add a sampler channel or place an audio file on the Playlist in a saved copy',
    { sample: string, name: label, mixer: index, placement: object({ track: index, start: tick, length }) },
    async (song, { sample, name, mixer = 0, placement }) => {
      sample = localFile(sample, sampleExtensions);
      if (!(await stat(sample)).isFile()) throw new Error('Sample must be a file');
      at(song.mixer, mixer, 'Mixer');
      const channel = song.channels.length;
      song.channels.push({ name, instrument: placement ? 'audioClip' : 'sampler', sample, mixer, volume: 0.8, pan: 0 });
      if (placement) song.playlist.push([0, placement.track, placement.start, placement.length, 0, 1, channel]);
      return { channel, clip: placement ? song.playlist.length - 1 : null };
    }, ['mixer', 'placement']),
  lynx_duplicate_pattern: copyTool('Duplicate a pattern, including note attributes and markers, in a project copy',
    { pattern: index, name: label }, (song, { pattern, name }) => {
      const source = at(song.patterns, pattern, 'Pattern');
      const copy = structuredClone(source);
      delete copy.uid;
      copy.name = name;
      song.patterns.push(copy);
      return { pattern: song.patterns.length - 1 };
    }),
  lynx_transpose_pattern: copyTool('Transpose a pattern or one channel within it by semitones',
    { pattern: index, semitones: integer(-127, 127), channel: index },
    (song, { pattern, semitones, channel }) => {
      if (channel !== undefined) at(song.channels, channel, 'Channel');
      const notes = (at(song.patterns, pattern, 'Pattern').notes ?? []).filter(note => channel === undefined || note[2] === channel);
      if (notes.some(note => note[3] + semitones < 0 || note[3] + semitones > 127))
        throw new Error('Transposition would put a note outside MIDI pitch range');
      for (const note of notes) note[3] += semitones;
      return { notesChanged: notes.length };
    }, ['channel']),
  lynx_quantize_pattern: copyTool('Snap note starts in a pattern to a tick grid while preserving note lengths',
    { pattern: index, grid: integer(1, 30720), strength: number(0, 1), channel: index },
    (song, { pattern, grid, strength = 1, channel }) => {
      if (channel !== undefined) at(song.channels, channel, 'Channel');
      let notesChanged = 0;
      for (const note of at(song.patterns, pattern, 'Pattern').notes ?? []) {
        if (channel !== undefined && note[2] !== channel) continue;
        const next = Math.round(note[0] + (Math.round(note[0] / grid) * grid - note[0]) * strength);
        if (next !== note[0]) notesChanged++;
        note[0] = next;
      }
      return { notesChanged };
    }, ['strength', 'channel']),
  lynx_add_markers: copyTool('Append named timeline markers to a Playlist arrangement or Piano Roll pattern',
    { pattern: index, arrangement: index, markers: array(object({ tick, name: label }), 1000) },
    (song, { pattern, arrangement, markers }) => {
      if (pattern !== undefined && arrangement !== undefined) throw new Error('Select a pattern or an arrangement');
      let destination;
      if (pattern !== undefined) destination = at(song.patterns, pattern, 'Pattern');
      else {
        if (!song.arrangements?.length) song.arrangements = [{ name: 'Arrangement 1' }];
        destination = at(song.arrangements, arrangement ?? song.currentArrangement ?? 0, 'Arrangement');
      }
      destination.markers ??= [];
      destination.markers.push(...markers.map(marker => [marker.tick, marker.name, 0, 0]));
      destination.markers.sort((a, b) => a[0] - b[0]);
      return { markersAdded: markers.length };
    }, ['pattern', 'arrangement']),
  lynx_edit_audio_clip: copyTool('Set gain, fades, mute, pan, pitch, reverse or stretch for an existing audio clip',
    { clip: index, changes: object({ fadeIn: tick, fadeOut: tick, gain: number(0, 63.1), muted: boolean,
      pan: number(-1, 1), pitch: number(-12, 12), reversed: boolean, stretch: number(0.01, 100) }, []) },
    (song, { clip, changes }) => {
      const row = at(song.playlist, clip, 'Playlist clip');
      if (row[5] !== 1) throw new Error('Select an audio clip');
      const defaults = [0, 0, 1, false, 0, 0, 0, false, 1];
      while (row.length < 16) row.push(defaults[row.length - 7]);
      const columns = { fadeIn: 7, fadeOut: 8, gain: 9, muted: 10, pan: 12, pitch: 13, reversed: 14, stretch: 15 };
      for (const [key, value] of Object.entries(changes)) row[columns[key]] = value;
      return { clip };
    }),
  lynx_create_automation: copyTool('Create a mixer or channel volume/pan automation lane and optionally place it on the Playlist',
    { name: label, target: { type: 'string', enum: ['mixerVolume', 'mixerPan', 'channelVolume', 'channelPan'] },
      targetIndex: index, points: array(object({ tick, value: number(0, 1), curve: number(-1, 1) }, ['tick', 'value']), 10000),
      placement: object({ track: index, start: tick, length }) },
    (song, args) => {
      at(args.target.startsWith('mixer') ? song.mixer : song.channels, args.targetIndex, 'Automation target');
      if (!args.points.length) throw new Error('Provide at least one automation point');
      const points = [...args.points].sort((a, b) => a.tick - b.tick).map(p => [p.tick, p.value, p.curve ?? 0]);
      song.automations ??= [];
      const lane = song.automations.length;
      song.automations.push({ name: args.name, target: [args.target, args.targetIndex, 0, 0], points });
      const p = args.placement;
      if (p) song.playlist.push([0, p.track, p.start, p.length, 0, 2, lane]);
      return { lane, clip: p ? song.playlist.length - 1 : null };
    }, ['placement']),
  lynx_place_automation: copyTool('Place an existing automation lane as a Playlist clip in a project copy',
    { lane: index, track: index, start: tick, length },
    (song, args) => {
      at(song.automations, args.lane, 'Automation');
      song.playlist.push([0, args.track, args.start, args.length, 0, 2, args.lane]);
      return { clip: song.playlist.length - 1 };
    }),
  lynx_read_arrangement: ['Read markers, loop bounds and Playlist clips for any saved arrangement',
    object({ project: string, arrangement: index, ...page }, ['project']),
    async ({ project, arrangement, offset = 0, limit = 200 }) => {
      const { song } = await load(project);
      const current = song.currentArrangement ?? 0;
      const i = arrangement ?? current;
      const entry = at(song.arrangements?.length ? song.arrangements : [{ name: 'Arrangement 1' }], i, 'Arrangement');
      const clips = (i === current ? song.playlist : entry.clips) ?? [];
      return { index: i, name: entry.name, active: i === current, total: clips.length, offset,
        markers: entry.markers ?? [], loop: (i === current ? song.loop : entry.loop) ?? null,
        columns: ['pattern', 'track', 'start', 'length', 'offset', 'kind', 'reference'],
        clips: clips.slice(offset, offset + limit) };
    }],
  lynx_set_loop: ['Set or clear the active arrangement loop on a saved project copy',
    object({ project: string, output: string, start: tick, end: tick }, ['project', 'output']),
    async ({ project, output, start, end }) => {
      const { file, song } = await load(project);
      if (start === undefined && end === undefined) delete song.loop;
      else {
        if (start === undefined || end === undefined || end <= start)
          throw new Error('Provide start and end ticks with end greater than start');
        song.loop = [start, end];
      }
      return { output: await writeProjectCopy(file, output, song), loop: song.loop ?? null };
    }],
  lynx_read_automation: ['Read the target and points of an automation lane in a saved LYNX project',
    object({ project: string, lane: index, ...page }, ['project', 'lane']),
    async ({ project, lane, offset = 0, limit = 200 }) => {
      const { song } = await load(project);
      const { name, target, points = [] } = at(song.automations, lane, 'Automation');
      return { name, target, total: points.length, offset, columns: ['tick', 'value', 'curve'],
        points: points.slice(offset, offset + limit) };
    }],
  lynx_read_mixer_insert: ['Read a mixer insert and its effect slots without including opaque plugin state',
    object({ project: string, insert: index }), async ({ project, insert }) => {
      const { song } = await load(project);
      const { effects = [], name, volume, pan, muted, solo } = at(song.mixer, insert, 'Mixer');
      return { insert, name, volume, pan, muted, solo, effects: effects.map((slot, index) =>
        ({ index, name: slot.name, kind: slot.kind ?? slot.type, enabled: slot.enabled, mix: slot.mix })) };
    }],
  lynx_list_sample_references: ['List sample paths stored on channels and indicate whether each resolves beside the project',
    object({ project: string, ...page }, ['project']), async ({ project, offset = 0, limit = 200 }) => {
      const { file, song } = await load(project);
      const samples = song.channels.flatMap((channel, index) => channel.sample ?
        [{ index, name: channel.name, sample: channel.sample }] : []);
      const items = await Promise.all(samples.slice(offset, offset + limit).map(async entry => ({
        ...entry, existsAtStoredPath: await stat(path.resolve(path.dirname(file), entry.sample))
          .then(info => info.isFile(), () => false)
      })));
      return { total: samples.length, offset, samples: items };
    }],
  lynx_relink_samples: ['Replace specified channel sample paths in a new project copy',
    object({ project: string, output: string, replacements: array(object({ channel: index, sample: string }), 1000) }),
    async ({ project, output, replacements }) => {
      const { file, song } = await load(project);
      for (const item of replacements) {
        const channel = at(song.channels, item.channel, 'Channel');
        if (!channel.sample) throw new Error('Channel has no sample reference: ' + item.channel);
        const sample = localFile(item.sample, ['.wav', '.flac', '.ogg', '.mp3', '.aif', '.aiff']);
        if (!(await stat(sample)).isFile()) throw new Error('Sample is not a file');
        channel.sample = sample;
      }
      return { output: await writeProjectCopy(file, output, song), relinked: replacements.length };
    }],
  lynx_project_metadata: ['Read project notes or write updated title, author, genre, URL and comments to a project copy',
    object({ project: string, output: string, info: metadata }, ['project']),
    async ({ project, output, info }) => {
      const { file, song } = await load(project);
      if ((output === undefined) !== (info === undefined)) throw new Error('Provide both output and info to edit metadata');
      if (!info) return { info: song.info ?? {} };
      song.info = { ...song.info, ...info };
      return { output: await writeProjectCopy(file, output, song), info: song.info };
    }],
  lynx_pattern_to_midi: ['Export notes from a saved pattern as standard MIDI, mapping project channels to MIDI channels',
    object({ project: string, output: string, pattern: index, channels: array(index, 16) }),
    async ({ project, output, pattern, channels }) => {
      if (!channels.length || new Set(channels).size !== channels.length)
        throw new Error('Provide 1 to 16 unique project channel indices in MIDI channel order');
      const { song } = await load(project);
      channels.forEach(i => at(song.channels, i, 'Channel'));
      const { notes = [] } = at(song.patterns, pattern, 'Pattern');
      const selected = notes.flatMap(([start, length, channel, pitch, velocity]) => {
        const i = channels.indexOf(channel);
        return i < 0 ? [] : [{ start, length, channel: i + 1, pitch, velocity: Math.max(0.01, Math.min(1, velocity ?? 0.8)) }];
      });
      const destination = localFile(output, ['.mid', '.midi']);
      await writeFile(destination, midiFile(song.bpm, 960, selected), { flag: 'wx' });
      return { output: destination, notes: selected.length, channels };
    }],
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
