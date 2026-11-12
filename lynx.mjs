import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { stat, mkdtemp, copyFile, rm, constants, mkdir, cp, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { object, string, integer, localFile } from './music.mjs';

const exe = process.env.LYNX_EXE;
const cwd = exe ? path.dirname(exe) : undefined;

function executable() {
  if (!exe || !path.isAbsolute(exe))
    throw new Error('Set LYNX_EXE to the full path to your LYNX.exe.');
  return exe;
}
const run = promisify(execFile);
const project = string;
const output = string;
const flag = { type: 'boolean' };
const projectTypes = ['.lynx', '.flp', '.als', '.flm', '.mid', '.midi'];
const convertible = ['.lynx', '.flp', '.als'];

async function check(file, directory = false) {
  const info = await stat(file);
  if (directory ? !info.isDirectory() : !info.isFile()) throw new Error('Unexpected file type: ' + file);
  return file;
}

async function input(value, extensions = projectTypes) {
  return check(localFile(value, extensions));
}

async function command(...args) {
  await check(executable());
  await run(exe, args, { cwd, windowsHide: true, timeout: 300000 });
}

async function temporary(work) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'lynx-mcp-'));
  try {
    return await work(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function newFile(outputPath, extensions, produce) {
  const destination = localFile(outputPath, extensions);
  await check(path.dirname(destination), true);
  return temporary(async dir => {
    const temp = path.join(dir, 'result' + path.extname(destination).toLowerCase());
    await produce(temp);
    const info = await stat(temp);
    if (!info.isFile() || !info.size) throw new Error('LYNX produced no output');
    await copyFile(temp, destination, constants.COPYFILE_EXCL);
    return { output: destination, bytes: info.size };
  });
}

function directoryPath(value) {
  const sentinel = localFile(path.join(value, 'folder.check'), ['.check']);
  return path.dirname(sentinel);
}

async function newFolder(outputPath, produce, expected) {
  const destination = directoryPath(outputPath);
  await check(path.dirname(destination), true);
  return temporary(async dir => {
    await produce(dir);
    const files = await readdir(dir, { recursive: true });
    if (!files.some(expected)) throw new Error('LYNX did not produce the expected export');
    await mkdir(destination);
    try {
      for (const entry of await readdir(dir))
        await cp(path.join(dir, entry), path.join(destination, entry),
          { recursive: true, force: false, errorOnExist: true });
    } catch (error) {
      // Keep partial files visible if copying fails.
      throw new Error('Could not finish copying to ' + destination + ': ' + error.message);
    }
    return { output: destination, entries: files.slice(0, 150), totalEntries: files.length };
  });
}

async function report(makeReport) {
  return temporary(async dir => {
    const file = path.join(dir, 'report.txt');
    await makeReport(file);
    const data = await readFile(file, 'utf8');
    return { report: data.slice(0, 24000), truncated: data.length > 24000 };
  });
}

export const lynx = {
  lynx_status: ['Check the LYNX executable and locate the bundled demo', object({}), async () => {
    await check(executable());
    const demo = path.join(cwd, 'Demo.lynx');
    return { executable: exe, demo: await check(demo).catch(() => null) };
  }],
  lynx_open: ['Open a saved project or MIDI file in LYNX', object({ project }), async args => {
    const file = await input(args.project);
    await check(executable());
    const child = spawn(exe, [file], { cwd, detached: true, stdio: 'ignore' });
    await new Promise((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', reject);
    });
    child.unref();
    return { launched: file };
  }],
  lynx_export: ['Export the song or selected pattern to WAV, FLAC or OGG, optionally from one mixer insert',
    object({ project, output, pattern: flag, insert: integer(0, 500) }, ['project', 'output']),
    async args => {
      const file = await input(args.project);
      return newFile(args.output, ['.wav', '.flac', '.ogg'], out =>
        command('--export', file, out, ...(args.pattern ? ['--pattern'] : []),
          ...(args.insert === undefined ? [] : ['--insert', String(args.insert)])));
    }],
  lynx_render_pattern: ['Render a fixed duration of the current pattern to WAV',
    object({ project, output, seconds: integer(1, 600) }), async args => {
      const file = await input(args.project);
      return newFile(args.output, ['.wav'], out => command('--render', file, out, String(args.seconds)));
    }],
  lynx_export_fl_studio: ['Convert a saved project to FL Studio FLP or a ZIP with samples',
    object({ project, output }), async args => {
      const file = await input(args.project, convertible);
      return newFile(args.output, ['.flp', '.zip'], out => command('--export-flp', file, out));
    }],
  lynx_export_ableton: ['Convert a saved project to an Ableton Live set in a new output folder',
    object({ project, output, live11: flag }, ['project', 'output']), async args => {
      const file = await input(args.project, convertible);
      return newFolder(args.output, out => command('--export-als', file, out, ...(args.live11 ? ['--live11'] : [])),
        entry => entry.toLowerCase().endsWith('.als'));
    }],
  lynx_export_bundle: ['Export a saved project for other DAWs into a new folder',
    object({ project, output, mixdown: flag }, ['project', 'output']), async args => {
      const file = await input(args.project, convertible);
      return newFolder(args.output,
        out => command('--export-bundle', file, out, ...(args.mixdown === false ? ['--no-mixdown'] : [])),
        entry => /\.(wav|mid|midi|zip)$/i.test(entry));
    }],
  lynx_snapshot: ['Render LYNX interface screenshots from a saved project into a new folder',
    object({ project, output }), async args => {
      const file = await input(args.project);
      return newFolder(args.output, out => command('--snapshot', path.join(out, 'lynx'), file),
        entry => /\.png$/i.test(entry));
    }],
  lynx_create_demo: ['Generate the built-in LYNX demo as a new project',
    object({ output }), args => newFile(args.output, ['.lynx'], out => command('--showcase', out))],
  lynx_audio_devices: ['List LYNX audio drivers and devices', object({}),
    () => report(file => command('--devices', file))],
  lynx_test_plugin: ['Load and test a trusted VST3 or CLAP plugin with LYNX and return its report',
    object({ plugin: string }), async ({ plugin }) => {
      const file = localFile(plugin, ['.vst3', '.clap']);
      await stat(file);
      return report(out => command('--plugintest', file, out));
    }],
  lynx_fl_plugin_database: ['Report the FL Studio installation and plugin database, optionally matching a project',
    object({ project }, []), async args => {
      const files = args.project ? [await input(args.project, ['.flp'])] : [];
      return report(out => command('--fldb', out, ...files));
    }]
};



