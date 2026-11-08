import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Reads a tracked file with LF endings, so assertions never depend on the runner OS. */
function read(relative) {
  return fs.readFileSync(path.join(ROOT, relative), 'utf8').replace(/\r\n/g, '\n');
}

function toCrlf(text) {
  return String(text).replace(/\r\n/g, '\n').replace(/\n/g, '\r\n');
}

function unquote(value) {
  const text = String(value).trim();
  if (text.startsWith('"') && text.endsWith('"')) return text.slice(1, -1);
  return text;
}

/** Minimal YAML subset parser: nested maps, lists of scalars, quoted strings. CRLF safe. */
function parseYaml(source) {
  const lines = source
    .replace(/\r\n/g, '\n')
    .split('\n')
    .filter((line) => line.trim() && !line.trim().startsWith('#'));
  let index = 0;

  function parseBlock(indent) {
    const result = {};
    while (index < lines.length) {
      const line = lines[index];
      const lineIndent = line.match(/^\s*/)[0].length;
      if (lineIndent < indent) break;
      if (line.trim().startsWith('-')) break;
      const pair = line.match(/^\s*([A-Za-z0-9_.-]+):\s*(.*)$/);
      assert.ok(pair, `invalid yaml line: ${JSON.stringify(line)}`);
      index += 1;
      const [, key, rawValue] = pair;
      if (rawValue.trim() !== '') {
        result[key] = unquote(rawValue);
        continue;
      }
      const next = lines[index];
      if (!next) {
        result[key] = null;
        continue;
      }
      const nextIndent = next.match(/^\s*/)[0].length;
      if (next.trim().startsWith('-')) {
        const list = [];
        while (index < lines.length) {
          const item = lines[index].match(/^(\s*)-\s+(.+)$/);
          if (!item || item[1].length !== nextIndent) break;
          list.push(unquote(item[2].trim()));
          index += 1;
        }
        result[key] = list;
      } else {
        result[key] = parseBlock(nextIndent);
      }
    }
    return result;
  }

  const parsed = parseBlock(0);
  assert.equal(index, lines.length, 'unparsed yaml tail');
  return parsed;
}

/** CRLF and LF both accepted, with or without a final newline after the closing fence. */
function parseFrontmatter(source) {
  const text = String(source).replace(/\r\n/g, '\n');
  const match = text.match(/^---\n([\s\S]*?)\n---(?:\n|$)/);
  assert.ok(match, 'frontmatter block is missing');
  return parseYaml(match[1]);
}

function flagsIn(text) {
  const normalized = String(text).replace(/\r\n/g, '\n');
  return new Set(normalized.replace(/`[^`]*git [^`]*`/g, ' ').replace(/npx --yes/g, 'npx').match(/--[a-z][a-z-]*/g) ?? []);
}

function comparisonCells(text) {
  const lines = String(text).replace(/\r\n/g, '\n').split('\n');
  const start = lines.findIndex((line) => line.startsWith('|') && /Feature|Característica/.test(line));
  assert.notEqual(start, -1, 'comparison table not found');
  const rows = [];
  for (const line of lines.slice(start + 2)) {
    if (!line.startsWith('|')) break;
    rows.push(line.split('|').slice(1, -1).map((cell) => cell.trim()));
  }
  return rows;
}

function emDashLinesInProse(text) {
  const lines = String(text).replace(/\r\n/g, '\n').split('\n');
  const offenders = [];
  let inFence = false;
  for (const line of lines) {
    if (line.trim().startsWith('```')) {
      inFence = !inFence;
      continue;
    }
    if (inFence || line.startsWith('|')) continue;
    if (line.includes('—')) offenders.push(line);
  }
  return offenders;
}

function walk(directory) {
  const entries = fs.readdirSync(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...walk(full));
    else files.push(full);
  }
  return files;
}

const readSkill = () => read('SKILL.md');
const readAgent = () => read('agents/openai.yaml');
const readPackage = () => JSON.parse(read('package.json'));

describe('manifests: line endings', () => {
  it('parses SKILL.md identically with LF and CRLF', () => {
    const lf = parseFrontmatter(readSkill());
    const crlf = parseFrontmatter(toCrlf(readSkill()));
    assert.deepEqual(crlf, lf);
    assert.equal(crlf.name, 'cold-jury');
    assert.equal(crlf.metadata.version, '0.1.0');
  });

  it('parses agents/openai.yaml identically with LF and CRLF', () => {
    const lf = parseYaml(readAgent());
    const crlf = parseYaml(toCrlf(readAgent()));
    assert.deepEqual(crlf, lf);
    assert.equal(crlf.interface.display_name, 'Cold Jury');
    assert.deepEqual(crlf.commands, ['doctor', 'review', 'install-hook']);
  });

  it('keeps the README scans identical with LF and CRLF', () => {
    for (const file of ['README.md', 'README.es.md']) {
      const lf = read(file);
      const crlf = toCrlf(lf);
      assert.deepEqual([...flagsIn(crlf)].sort(), [...flagsIn(lf)].sort());
      assert.deepEqual(comparisonCells(crlf), comparisonCells(lf));
      assert.deepEqual(emDashLinesInProse(crlf), emDashLinesInProse(lf));
      const lfRows = comparisonCells(lf);
      assert.ok(lfRows.length >= 8);
      for (const row of lfRows) {
        for (const cell of row.slice(1)) assert.ok(cell === '✓' || cell === '—');
      }
      assert.deepEqual(emDashLinesInProse(lf), []);
    }
  });

  it('accepts CRLF frontmatter and yaml with a trailing newline', () => {
    const parsed = parseFrontmatter(`---\r\nname: cold-jury\r\ndescription: "x"\r\n---\r\n`);
    assert.equal(parsed.name, 'cold-jury');
    assert.equal(parseYaml('name: cold-jury\r\ncommands:\r\n  - doctor\r\n').commands[0], 'doctor');
  });
});

describe('manifests: SKILL.md', () => {
  it('uses the strict AAIF keys and nests the version', () => {
    const fields = parseFrontmatter(readSkill());
    assert.deepEqual(Object.keys(fields).sort(), ['description', 'license', 'metadata', 'name']);
    assert.equal(fields.name, 'cold-jury');
    assert.equal(fields.license, 'MIT');
    assert.equal(fields.metadata.version, '0.1.0');
    assert.equal('version' in fields, false, 'version must live under metadata');
  });

  it('keeps the description quoted, portable and under 220 characters', () => {
    const fields = parseFrontmatter(readSkill());
    assert.match(readSkill(), /^description: ".*"$/m);
    assert.ok(fields.description.length > 40);
    assert.ok(fields.description.length < 220, `description is ${fields.description.length} chars`);
  });

  it('documents the local binary and the GitHub fallback', () => {
    const body = readSkill();
    assert.ok(body.includes('node <skill-dir>/bin/cold-jury.mjs'));
    assert.ok(body.includes('npx --yes github:Dimoncelli/cold-jury'));
    assert.equal(body.includes('npx cold-jury'), false);
    for (const command of ['doctor', 'review', 'install-hook']) {
      assert.ok(body.includes(command), `missing ${command}`);
    }
    for (const flag of ['--spec', '--author', '--json', '--output', '--fail-on', '--allow-same-engine']) {
      assert.ok(body.includes(flag), `missing ${flag}`);
    }
  });
});

describe('manifests: codex agent file', () => {
  it('declares a node entrypoint and the three commands', () => {
    const fields = parseYaml(readAgent());
    assert.equal(fields.name, 'cold-jury');
    assert.equal(fields.version, '0.1.0');
    assert.equal(fields.entrypoint, 'bin/cold-jury.mjs');
    assert.equal(fields.runtime, 'node');
    assert.equal(fields.node, '>=20');
    assert.deepEqual(fields.commands, ['doctor', 'review', 'install-hook']);
  });

  it('ships the interface block Codex expects', () => {
    const fields = parseYaml(readAgent());
    assert.equal(fields.interface.display_name, 'Cold Jury');
    assert.ok(fields.interface.short_description.length > 20);
    assert.ok(fields.interface.short_description.length < 120);
    assert.ok(fields.interface.default_prompt.length > 20);
    assert.match(readAgent(), /^  default_prompt: ".*"$/m);
  });
});

describe('manifests: claude code plugin', () => {
  it('parses plugin.json with repository metadata', () => {
    const plugin = JSON.parse(read('.claude-plugin/plugin.json'));
    assert.equal(plugin.name, 'cold-jury');
    assert.equal(plugin.version, '0.1.0');
    assert.equal(plugin.license, 'MIT');
    assert.equal(plugin.author.name, 'Dimoncelli');
    assert.deepEqual(plugin.skills, ['SKILL.md']);
    assert.equal(plugin.homepage, 'https://github.com/Dimoncelli/cold-jury');
    assert.equal(plugin.repository.url, 'git+https://github.com/Dimoncelli/cold-jury.git');
    assert.equal(plugin.bugs.url, 'https://github.com/Dimoncelli/cold-jury/issues');
  });

  it('parses marketplace.json and points at the package root', () => {
    const marketplace = JSON.parse(read('.claude-plugin/marketplace.json'));
    assert.equal(marketplace.name, 'cold-jury');
    assert.equal(marketplace.owner.name, 'Dimoncelli');
    assert.equal(marketplace.plugins.length, 1);
    assert.equal(marketplace.plugins[0].name, 'cold-jury');
    assert.equal(marketplace.plugins[0].source, './');
  });
});

describe('manifests: package.json', () => {
  it('ships zero dependencies and a node bin', () => {
    const pkg = readPackage();
    assert.deepEqual(pkg.dependencies, {});
    assert.deepEqual(pkg.devDependencies, {});
    assert.equal(pkg.type, 'module');
    assert.equal(pkg.bin['cold-jury'], './bin/cold-jury.mjs');
    assert.equal(pkg.engines.node, '>=20');
    assert.equal(pkg.license, 'MIT');
    assert.equal(pkg.version, '0.1.0');
    assert.equal('postinstall' in (pkg.scripts ?? {}), false);
  });

  it('points every metadata field at the public repository', () => {
    const pkg = readPackage();
    assert.equal(pkg.homepage, 'https://github.com/Dimoncelli/cold-jury');
    assert.equal(pkg.repository.url, 'git+https://github.com/Dimoncelli/cold-jury.git');
    assert.equal(pkg.bugs.url, 'https://github.com/Dimoncelli/cold-jury/issues');
  });
});

describe('readme: CLI parity and safe examples', () => {
  const known = new Set([
    '--staged',
    '--range',
    '--spec',
    '--author',
    '--jurors',
    '--probes',
    '--json',
    '--fail-on',
    '--allow-same-engine',
    '--timeout',
    '--max-bytes',
    '--output',
    '--no-color',
    '--version',
    '--help',
    '--doctor',
    '--force',
    '--type',
  ]);

  for (const file of ['README.md', 'README.es.md']) {
    it(`${file} only names flags the parser accepts`, () => {
      const flags = flagsIn(read(file));
      for (const flag of flags) {
        assert.ok(known.has(flag), `${file} mentions unknown flag ${flag}`);
      }
    });

    it(`${file} names the real subcommands`, () => {
      const text = read(file);
      for (const command of ['cold-jury doctor', 'cold-jury review', 'cold-jury install-hook']) {
        assert.ok(text.includes(command), `${file} is missing ${command}`);
      }
    });

    it(`${file} installs from GitHub, not from npm`, () => {
      const text = read(file);
      assert.ok(text.includes('npx --yes github:Dimoncelli/cold-jury'));
      assert.equal(text.includes('npx cold-jury'), false, 'no npm squatting surface');
    });

    it(`${file} keeps the workflow safe`, () => {
      const text = read(file);
      assert.ok(text.includes('PR_TITLE: ${{ github.event.pull_request.title }}'));
      assert.ok(text.includes('BASE_REF: ${{ github.base_ref }}'));
      assert.equal(text.includes('--spec "${{'), false);
      assert.equal(text.includes('--range "origin/${{'), false);
      assert.ok(text.includes('actions/checkout@v7'), 'workflow must use the current checkout');
      assert.ok(text.includes('actions/setup-node@v7'), 'workflow must use the current setup-node');
      assert.equal(text.includes('actions/checkout@v4'), false);
      assert.equal(text.includes('actions/setup-node@v4'), false);
    });

    it(`${file} documents the real render output`, () => {
      const text = read(file);
      assert.ok(text.includes('JUROR        PROBE         LEVEL  LOCATION'));
      assert.ok(text.includes('VERDICT: BLOCK (exit 1) | P0 0 | P1 1 | P2 2'));
    });

    it(`${file} keeps comparison cells to a tick or a dash`, () => {
      const rows = comparisonCells(read(file));
      assert.ok(rows.length >= 8, `expected at least 8 comparison rows, saw ${rows.length}`);
      for (const row of rows) {
        assert.ok(row.length >= 4);
        for (const cell of row.slice(1)) {
          assert.ok(cell === '✓' || cell === '—', `unexpected comparison cell: ${cell}`);
        }
      }
    });

    it(`${file} uses no em dash in prose`, () => {
      assert.deepEqual(emDashLinesInProse(read(file)), []);
    });
  }

  it('README.es.md says the jurors run in parallel', () => {
    assert.ok(read('README.es.md').includes('se ejecutan en paralelo'));
  });
});

describe('hygiene: no private data, no shell execution', () => {
  it('keeps the published tree clean', () => {
    const forbidden = new RegExp(
      [
        'C:' + '\\\\Users',
        'dimon' + 'celli@',
        'gmail' + '\\.com',
        'shell\\s*:\\s*tr' + 'ue',
        'ex' + 'ec\\(',
        'execF' + 'ile\\(',
      ].join('|'),
      'i',
    );
    const targets = [
      ...walk(path.join(ROOT, 'src')),
      ...walk(path.join(ROOT, 'tests')),
      path.join(ROOT, 'SKILL.md'),
      path.join(ROOT, 'README.md'),
      path.join(ROOT, 'README.es.md'),
      ...walk(path.join(ROOT, 'agents')),
      ...walk(path.join(ROOT, '.claude-plugin')),
    ];
    for (const file of targets) {
      const content = fs.readFileSync(file, 'utf8');
      const match = content.match(forbidden);
      assert.equal(match, null, `${path.relative(ROOT, file)} contains ${match?.[0]}`);
    }
  });

  it('ships no postinstall or network install hooks', () => {
    const pkg = readPackage();
    for (const script of ['preinstall', 'postinstall', 'prepare']) {
      assert.equal(script in (pkg.scripts ?? {}), false);
    }
  });
});

describe('repository: line ending policy', () => {
  it('.gitattributes pins LF for every runner text file', () => {
    const text = read('.gitattributes');
    assert.ok(text.includes('* text=auto eol=lf'));
    assert.ok(text.includes('*.cmd text eol=crlf'));
    assert.ok(text.includes('*.bat text eol=crlf'));
    assert.ok(text.includes('*.ps1 text eol=crlf'));
  });

  it('.gitattributes stays out of the npm tarball', () => {
    const pkg = readPackage();
    for (const entry of pkg.files) {
      assert.notEqual(entry, '.gitattributes');
    }
    assert.equal(pkg.files.includes('.gitattributes'), false);
  });

  it('CI and docs use the current GitHub Actions versions', () => {
    const ci = read('.github/workflows/ci.yml');
    assert.ok(ci.includes('actions/checkout@v7'));
    assert.ok(ci.includes('actions/setup-node@v7'));
    assert.equal(ci.includes('actions/checkout@v4'), false);
    assert.equal(ci.includes('actions/setup-node@v4'), false);
    for (const file of ['README.md', 'README.es.md']) {
      assert.ok(read(file).includes('actions/checkout@v7'));
      assert.ok(read(file).includes('actions/setup-node@v7'));
    }
  });
});
