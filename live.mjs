import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { object, integer, string, array, localFile } from './music.mjs';

const run = promisify(execFile);
const helper = fileURLToPath(new URL('./midi-out.exe', import.meta.url));
const byte = integer(0, 127);
const port = integer(0, 1024);
const strip = integer(1, 8);
const commands = [
  'transport.play', 'transport.stop', 'transport.record', 'transport.loop',
  'transport.metronome', 'transport.tap', 'transport.rewind', 'transport.forward',
  'edit.undo', 'pattern.previous', 'pattern.next', 'mixer.bank.left', 'mixer.bank.right',
  'mixer.strip.left', 'mixer.strip.right', 'channel.bank.left', 'channel.bank.right',
  'channel.previous', 'channel.next', 'plugin.page.left', 'plugin.page.right'
];
const continuous = { 'mixer.volume': 0, 'mixer.pan': 8, 'channel.volume': 16, 'channel.pan': 24, 'plugin.param': 40 };
const toggle = { 'mixer.mute': 32, 'mixer.solo': 40, 'mixer.select': 48, 'channel.mute': 56, 'channel.select': 64, 'mixer.arm': 72 };
const enumeration = values => ({ type: 'string', enum: values });
const noteOn = note => [[159, note, 127], [143, note, 0]];

async function ports() {
  const { stdout } = await run(helper, ['list'], { windowsHide: true, timeout: 10000 });
  return stdout.split(/\r?\n/).filter(Boolean).map(line => {
    const [id, ...rest] = line.split('\t');
    return { id: Number(id), name: rest.join('\t') };
  });
}

export async function settings() {
  const file = process.env.LYNX_MCP_SETTINGS || path.join(process.env.APPDATA ?? '', 'LYNX', 'mcp-settings.ini');
  const contents = await readFile(file).catch(error => {
    if (error.code === 'ENOENT') return Buffer.alloc(0);
    throw error;
  });
  const ini = contents[0] === 255 && contents[1] === 254 ? contents.toString('utf16le').slice(1) : contents.toString('utf8');
  const midiPort = Number(/^\s*MidiPort\s*=\s*(-?\d+)\s*$/im.exec(ini)?.[1] ?? -1);
  return { enabled: !/^\s*Enabled\s*=\s*0\s*$/im.test(ini), midiPort: midiPort >= 0 ? midiPort : null, file };
}

async function send(id, messages) {
  id ??= (await settings()).midiPort;
  if (id === null) throw new Error('Select a MIDI output in the LYNX SHARE MCP window or provide a port.');
  const device = (await ports()).find(p => p.id === id);
  if (!device) throw new Error('MIDI output does not exist. Call lynx_midi_outputs first.');
  const packed = messages.map(([status, a, b]) => String(status | (a << 8) | (b << 16)));
  if (packed.length) await run(helper, ['send', String(id), ...packed], { windowsHide: true, timeout: 10000 });
  return { device, messagesSent: packed.length };
}

export const live = {
  lynx_midi_outputs: ['List available Windows MIDI output ports', object({}), async () => ({ ports: await ports() })],
  lynx_create_controller_profile: ['Create the LYNX SHARE MCP MIDI controller profile for loading in LYNX MIDI settings',
    object({ output: string }), async ({ output }) => {
      output = localFile(output, ['.lynxctl']);
      const lines = ['[device]', 'name = LYNX SHARE MCP', 'maker = Localrcc', 'strips = 8', '', '[input]'];
      commands.forEach((action, i) => lines.push('note ' + i + ' ch 16 = ' + action));
      for (const [action, first] of Object.entries(continuous))
        lines.push('cc ' + first + '-' + (first + 7) + ' ch 16 = ' + action);
      for (const [action, first] of Object.entries(toggle))
        lines.push('note ' + first + '-' + (first + 7) + ' ch 16 = ' + action);
      lines.push('cc 32 ch 16 = master.volume', 'note 80-95 ch 16 = pad.step');
      await writeFile(output, lines.join('\n') + '\n', { flag: 'wx' });
      return { output };
    }],
  lynx_live_transport: ['Trigger a transport action in open LYNX through a configured LYNX SHARE MCP MIDI input',
    object({ port, action: enumeration(commands) }, ['action']),
    ({ port, action }) => send(port, noteOn(commands.indexOf(action)))],
  lynx_live_control: ['Adjust or toggle a mixer or Channel Rack strip through the configured LYNX SHARE MCP MIDI input',
    object({ port, action: enumeration([...Object.keys(continuous), ...Object.keys(toggle), 'master.volume']),
      strip, value: byte }, ['action']), ({ port, action, strip, value }) => {
      if (action === 'master.volume') {
        if (value === undefined) throw new Error('value is required');
        return send(port, [[191, 32, value]]);
      }
      if (strip === undefined) throw new Error('strip is required');
      if (Object.hasOwn(toggle, action)) return send(port, noteOn(toggle[action] + strip - 1));
      if (value === undefined) throw new Error('value is required');
      return send(port, [[191, continuous[action] + strip - 1, value]]);
    }],
  lynx_live_step: ['Toggle a step of the selected channel in the current pattern through the MIDI profile',
    object({ port, step: integer(1, 16) }, ['step']), ({ port, step }) => send(port, noteOn(79 + step))],
  lynx_send_midi: ['Send note-on, note-off, control change or pitch bend messages to a selected MIDI output',
    object({ port, messages: array(object({ type: enumeration(['note_on', 'note_off', 'cc', 'pitch_bend']),
      channel: integer(1, 16), data1: byte, data2: byte }), 512) }, ['messages']), ({ port, messages }) => {
      const status = { note_on: 144, note_off: 128, cc: 176, pitch_bend: 224 };
      return send(port, messages.map(m => [status[m.type] + m.channel - 1, m.data1, m.data2]));
    }]
};




