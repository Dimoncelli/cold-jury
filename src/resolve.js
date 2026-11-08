import fs from 'node:fs';
import path from 'node:path';

/**
 * Characters that cmd.exe still interprets inside double quotes (%VAR%, !VAR!,
 * caret escapes and a literal quote break the quoting), so a .cmd shim whose
 * path contains them is never handed to the cmd fallback.
 */
const CMD_UNSAFE = /["%\r\n!^]/;
const SHIM_TOKEN = /"(%~dp0|%dp0%)([^"]*)"/gi;
const SHIM_SKIP = new Set(['node.exe', 'node.cmd', 'node.bat', 'powershell.exe', 'pwsh.exe']);

export function quoteWindowsArg(value) {
  return `"${String(value).split('"').join('""')}"`;
}

export function isCmdSafe(value) {
  return !CMD_UNSAFE.test(String(value));
}

function isFile(fsImpl, target) {
  try {
    return fsImpl.statSync(target).isFile();
  } catch {
    return false;
  }
}

function isExecutable(fsImpl, target) {
  try {
    const stat = fsImpl.statSync(target);
    return stat.isFile() && (stat.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

function isInside(pathImpl, root, child) {
  const relative = pathImpl.relative(root, child);
  return relative !== '' && !relative.startsWith('..') && !pathImpl.isAbsolute(relative);
}

/**
 * npm ships `name.cmd` shims that resolve to a real .exe or .js entry. Extracting
 * that entry lets the runner skip cmd.exe entirely.
 */
export function parseNpmShim(content) {
  if (typeof content !== 'string') return null;
  const candidates = [];
  for (const match of content.matchAll(SHIM_TOKEN)) {
    const tail = match[2].replace(/^[\\/]+/, '').trim();
    if (!tail) continue;
    if (!/\.(?:exe|cmd|bat|js|cjs|mjs)$/i.test(tail)) continue;
    if (SHIM_SKIP.has(path.basename(tail).toLowerCase())) continue;
    candidates.push(tail);
  }
  return candidates[0] ?? null;
}

/**
 * Builds an execution plan for one concrete file. Returns null when the file
 * cannot be executed without putting user input in a cmd.exe command line.
 */
export function planBinary(target, options = {}) {
  const platform = options.platform ?? process.platform;
  const nodePath = options.nodePath ?? process.execPath;
  const fsImpl = options.fs ?? fs;
  const pathImpl = platform === 'win32' ? path.win32 : path.posix;
  const extension = platform === 'win32' ? pathImpl.extname(target).toLowerCase() : '';

  if (platform !== 'win32') {
    if (!isExecutable(fsImpl, target)) return null;
    return { command: target, prefixArgs: [], wrapper: 'direct', kind: 'binary', source: target };
  }

  if (extension === '.exe') {
    return { command: target, prefixArgs: [], wrapper: 'direct', kind: 'binary', source: target };
  }

  if (extension === '.cmd' || extension === '.bat') {
    let content = '';
    try {
      content = fsImpl.readFileSync(target, 'utf8');
    } catch {
      content = '';
    }
    const shimDir = pathImpl.dirname(target);
    const entry = parseNpmShim(content);
    if (entry) {
      const entryPath = pathImpl.resolve(shimDir, entry);
      const entryExtension = pathImpl.extname(entryPath).toLowerCase();
      const contained = isInside(pathImpl, shimDir, entryPath);
      if (contained && isFile(fsImpl, entryPath) && entryExtension === '.exe') {
        return {
          command: entryPath,
          prefixArgs: [],
          wrapper: 'direct',
          kind: 'npm-shim',
          source: target,
        };
      }
      if (contained && isFile(fsImpl, entryPath) && ['.js', '.cjs', '.mjs'].includes(entryExtension)) {
        return {
          command: nodePath,
          prefixArgs: [entryPath],
          wrapper: 'direct',
          kind: 'npm-shim',
          source: target,
        };
      }
    }
    if (!isCmdSafe(target)) return null;
    return {
      command: 'cmd.exe',
      prefixArgs: ['/d', '/s', '/c', quoteWindowsArg(target)],
      wrapper: 'cmd',
      kind: 'cmd-fallback',
      source: target,
    };
  }

  if (extension === '.ps1') {
    if (!isCmdSafe(target)) return null;
    return {
      command: 'powershell.exe',
      prefixArgs: [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'RemoteSigned',
        '-File',
        target,
      ],
      wrapper: 'direct',
      kind: 'powershell',
      source: target,
    };
  }

  return null;
}

/** Walks PATH looking for the CLI, in the platform specific order. */
export function resolveBinary(name, options = {}) {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const fsImpl = options.fs ?? fs;
  const fileName = String(name);
  if (!/^[A-Za-z0-9._-]+$/.test(fileName)) return null;

  const candidates =
    platform === 'win32'
      ? [`${fileName}.exe`, `${fileName}.cmd`, `${fileName}.ps1`]
      : [fileName];
  const pathImpl = platform === 'win32' ? path.win32 : path.posix;
  const delimiter = platform === 'win32' ? ';' : ':';
  const rawPath = env.PATH ?? env.Path ?? '';
  const dirs = String(rawPath)
    .split(delimiter)
    .map((entry) => entry.trim().replace(/^"(.*)"$/, '$1'))
    .filter(Boolean);

  for (const dir of dirs) {
    for (const candidate of candidates) {
      const full = pathImpl.join(dir, candidate);
      if (!isFile(fsImpl, full)) continue;
      const plan = planBinary(full, { ...options, platform });
      if (plan) return plan;
    }
  }
  return null;
}
