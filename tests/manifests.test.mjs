import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function read(relative) {
  return fs.readFileSync(path.join(ROOT, relative), 'utf8');
}

function unquote(value) {
  const text = String(value).trim();
  if (text.startsWith('"') && text.endsWith('"')) return text.slice(1, -1);
  return text;
}

/** Minimal YAML subset parser: nested maps, lists of scalars, quoted strings. */
function parseYaml(source) {
  const lines = source
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
      assert.ok(pair, `invalid yaml line: ${line}`);
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

function parseFrontmatter(source) {
  const match = source.match(/^---\n([\s\S]*?)\n---\n/);
  assert.ok(match, 'frontmatter block is missing');
  return parseYaml(match[1]);
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

describe('manifests: SKILL.md', () => {
  const fields = parseFrontmatter(read('SKILL.md'));

  it('uses the strict AAIF keys and nests the version', () => {
    assert.deepEqual(Object.keys(fields).sort(), ['description', 'license', 'metadata', 'name']);
    assert.equal(fields.name, 'cold-jury');
    assert.equal(fields.license, 'MIT');
    assert.equal(fields.metadata.version, '0.1.0');
    assert.equal('version' in fields, false, 'version must live under metadata');
  });

  it('keeps the description quoted, portable and under 220 characters', () => {
    assert.match(read('SKILL.md'), /^description: ".*"$/m);
    assert.ok(fields.description.length > 40);
    assert.ok(fields.description.length < 220, `description is ${fields.description.length} chars`);
  });

  it('documents the local binary and the GitHub fallback', () => {
    const body = read('SKILL.md');
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
  const fields = parseYaml(read('agents/openai.yaml'));

  it('declares a node entrypoint and the three commands', () => {
    assert.equal(fields.name, 'cold-jury');
    assert.equal(fields.version, '0.1.0');
    assert.equal(fields.entrypoint, 'bin/cold-jury.mjs');
    assert.equal(fields.runtime, 'node');
    assert.equal(fields.node, '>=20');
    assert.deepEqual(fields.commands, ['doctor', 'review', 'install-hook']);
  });

  it('ships the interface block Codex expects', () => {
    assert.equal(fields.interface.display_name, 'Cold Jury');
    assert.ok(fields.interface.short_description.length > 20);
    assert.ok(fields.interface.short_description.length < 120);
    assert.ok(fields.interface.default_prompt.length > 20);
    assert.match(read('agents/openai.yaml'), /^  default_prompt: ".*"$/m);
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
  const pkg = JSON.parse(read('package.json'));

  it('ships zero dependencies and a node bin', () => {
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
      const text = read(file).replace(/`[^`]*git [^`]*`/g, ' ').replace(/npx --yes/g, 'npx');
      const flags = new Set(text.match(/--[a-z][a-z-]*/g) ?? []);
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
    });

    it(`${file} documents the real render output`, () => {
      const text = read(file);
      assert.ok(text.includes('JUROR        PROBE         LEVEL  LOCATION'));
      assert.ok(text.includes('VERDICT: BLOCK (exit 1) | P0 0 | P1 1 | P2 2'));
    });

    it(`${file} keeps comparison cells to a tick or a dash`, () => {
      const lines = read(file).split('\n');
      const start = lines.findIndex(
        (line) => line.startsWith('|') && /Feature|Característica/.test(line),
      );
      assert.notEqual(start, -1, 'comparison table not found');
      let rows = 0;
      for (const line of lines.slice(start + 2)) {
        if (!line.startsWith('|')) break;
        const cells = line.split('|').slice(1, -1).map((cell) => cell.trim());
        assert.ok(cells.length >= 4);
        for (const cell of cells.slice(1)) {
          assert.ok(cell === '✓' || cell === '—', `unexpected comparison cell: ${cell}`);
        }
        rows += 1;
      }
      assert.ok(rows >= 8, `expected at least 8 comparison rows, saw ${rows}`);
    });

    it(`${file} uses no em dash in prose`, () => {
      const lines = read(file).split('\n');
      let inFence = false;
      for (const line of lines) {
        if (line.trim().startsWith('```')) {
          inFence = !inFence;
          continue;
        }
        if (inFence || line.startsWith('|')) continue;
        assert.equal(line.includes('—'), false, `em dash in prose: ${line}`);
      }
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
    const pkg = JSON.parse(read('package.json'));
    for (const script of ['preinstall', 'postinstall', 'prepare']) {
      assert.equal(script in (pkg.scripts ?? {}), false);
    }
  });
});
