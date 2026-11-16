const ANSI = Object.freeze({
  reset: '\u001b[0m',
  bold: '\u001b[1m',
  dim: '\u001b[2m',
  red: '\u001b[31m',
  green: '\u001b[32m',
  yellow: '\u001b[33m',
});

const ANSI_CSI = /\u001b\[[0-9;?]*[A-Za-z]/g;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;
const DEFAULT_COLUMNS = 88;
const COLUMN_GUTTER = 2;

/** Removes ANSI escapes and C0/C1 control characters coming from a juror. */
export function stripControl(value) {
  return String(value ?? '')
    .replace(ANSI_CSI, '')
    .replace(CONTROL_CHARS, ' ');
}

function paint(text, color, enabled) {
  return enabled ? `${color}${text}${ANSI.reset}` : text;
}

function truncateRight(text, width) {
  if (width <= 0) return '';
  const clean = stripControl(text);
  if (clean.length <= width) return clean;
  if (width <= 1) return '…';
  return `${clean.slice(0, width - 1)}…`;
}

/** Keeps the file name and the line number, which live at the end of a path. */
export function truncateLeft(text, width) {
  if (width <= 0) return '';
  const clean = stripControl(text);
  if (clean.length <= width) return clean;
  if (width <= 1) return '…';
  return `…${clean.slice(clean.length - (width - 1))}`;
}

export function findingLocation(finding) {
  if (!finding.file) return '-';
  const file = stripControl(finding.file);
  return finding.line ? `${file}:${finding.line}` : file;
}

function pad(text, width) {
  const clean = stripControl(text);
  return clean.length >= width ? clean : `${clean}${' '.repeat(width - clean.length)}`;
}

export function renderTable(verdict, options = {}) {
  const color = options.color === true;
  const columns = Number.isInteger(options.columns) && options.columns > 40 ? options.columns : DEFAULT_COLUMNS;
  const widths = [11, 12, 5, 22];
  const fixed = widths.reduce((sum, width) => sum + width, 0) + COLUMN_GUTTER * 4;
  const findingWidth = Math.max(12, columns - fixed);

  const lines = [];
  const jurorLabel = verdict.jurors.length > 0 ? verdict.jurors.join(',') : 'none';
  lines.push(
    paint(
      `cold-jury ${verdict.version} | author ${verdict.author || 'unknown'} | jurors ${jurorLabel}`,
      ANSI.bold,
      color,
    ),
  );
  lines.push(
    verdict.secretShield.leak
      ? paint(`SECRET SHIELD: LEAK (${verdict.secretShield.redactions} redactions)`, ANSI.red, color)
      : `SECRET SHIELD: CLEAN (${verdict.secretShield.redactions} redactions)`,
  );
  lines.push('');

  const clamp = (line) => (line.length > columns ? truncateRight(line, columns) : line);
  const header = clamp(
    [
      pad('JUROR', widths[0]),
      pad('PROBE', widths[1]),
      pad('LEVEL', widths[2]),
      pad('LOCATION', widths[3]),
      pad('FINDING', findingWidth),
    ]
      .join(' '.repeat(COLUMN_GUTTER))
      .trimEnd(),
  );
  lines.push(header);
  lines.push('-'.repeat(Math.max(header.length, Math.min(columns, 72))));

  if (verdict.findings.length === 0) {
    lines.push('(no findings)');
  } else {
    for (const finding of verdict.findings) {
      lines.push(
        clamp(
          [
            pad(truncateRight(finding.juror ?? '-', widths[0]), widths[0]),
            pad(truncateRight(finding.probe || '-', widths[1]), widths[1]),
            pad(truncateRight(finding.severity, widths[2]), widths[2]),
            pad(truncateLeft(findingLocation(finding), widths[3]), widths[3]),
            truncateRight(finding.title, findingWidth),
          ]
            .join(' '.repeat(COLUMN_GUTTER))
            .trimEnd(),
        ),
      );
    }
  }

  for (const error of verdict.errors ?? []) {
    const reason = `${error.engine}/${error.probe || '-'}: ${error.reason}`;
    lines.push(paint(`ENGINE ERROR: ${truncateRight(reason, columns - 14)}`, ANSI.yellow, color));
  }

  if (verdict.note) lines.push(`NOTE: ${truncateRight(verdict.note, columns - 6)}`);
  if (verdict.limit?.truncated) {
    lines.push(
      `LIMIT: input truncated to ${verdict.limit.maxBytes} bytes (${verdict.limit.originalBytes} before)`,
    );
  }

  lines.push('');
  const verdictColor = verdict.gate === 'BLOCK' ? ANSI.red : ANSI.green;
  lines.push(
    paint(
      `VERDICT: ${verdict.gate} (exit ${verdict.exitCode}) | P0 ${verdict.counts.P0} | P1 ${verdict.counts.P1} | P2 ${verdict.counts.P2}`,
      verdictColor,
      color,
    ),
  );
  return lines.join('\n');
}

export function renderJson(verdict) {
  return JSON.stringify(verdict, null, 2);
}

const METRIC_LABELS = Object.freeze([
  ['tool_selection_accuracy', 'tool selection accuracy'],
  ['mcp_compliance', 'MCP compliance'],
  ['turn_efficiency', 'turn efficiency'],
  ['workflow_completion', 'workflow completion'],
]);

/** Human table for `cold-jury trace`: metrics, probe verdicts and findings. */
export function renderTrace(verdict, options = {}) {
  const color = options.color === true;
  const columns = Number.isInteger(options.columns) && options.columns > 40 ? options.columns : DEFAULT_COLUMNS;
  const lines = [];

  lines.push(
    paint(
      `cold-jury ${verdict.version} | trace ${verdict.trace_id || 'unknown'} | ${verdict.verdict}`,
      ANSI.bold,
      color,
    ),
  );
  lines.push(
    verdict.secretShield?.leak
      ? paint(`SECRET SHIELD: LEAK (${verdict.secretShield.redactions} redactions)`, ANSI.red, color)
      : `SECRET SHIELD: CLEAN (${verdict.secretShield?.redactions ?? 0} redactions)`,
  );
  const hasMetrics = verdict.metrics && typeof verdict.metrics === 'object';
  if (hasMetrics) {
    lines.push('');
    lines.push('METRIC                       VALUE');
    for (const [key, label] of METRIC_LABELS) {
      const value = Number(verdict.metrics?.[key]);
      lines.push(`${pad(label, 28)} ${(Number.isFinite(value) ? value : 0).toFixed(2)}`);
    }
  }

  lines.push('');
  lines.push('TRACE PROBES');
  for (const [probe, result] of Object.entries(verdict.probes ?? {})) {
    const gate = result?.verdict === 'BLOCK' ? 'BLOCK' : 'PASS';
    lines.push(`${pad(probe, 28)} ${gate} (${result?.severity ?? 'NONE'})`);
  }

  lines.push('');
  if (!verdict.findings || verdict.findings.length === 0) {
    lines.push('(no findings)');
  } else {
    for (const finding of verdict.findings) {
      const label = `[${finding.severity}] ${finding.probe ? `${finding.probe} ` : ''}${finding.id}: ${finding.title}`;
      lines.push(truncateRight(label, columns));
    }
  }

  if (verdict.note) lines.push(`NOTE: ${truncateRight(verdict.note, columns - 6)}`);
  lines.push('');
  lines.push(
    paint(
      `VERDICT: ${verdict.verdict} (exit ${verdict.exitCode}) | severity ${verdict.severity}`,
      verdict.verdict === 'BLOCK' ? ANSI.red : ANSI.green,
      color,
    ),
  );
  return lines.join('\n');
}

export function renderDoctor(reports, options = {}) {
  const color = options.color === true;
  const engineWidth = reports.reduce((width, report) => Math.max(width, report.engine.length), 6);
  const lines = [`${pad('ENGINE', engineWidth)}  ${pad('STATUS', 9)}  ${pad('GATEWAY', 7)}  COMMAND`];
  for (const report of reports) {
    const label = pad(report.status, 9);
    const painted = paint(
      label,
      report.status === 'READY' ? ANSI.green : report.status === 'OFFLINE' ? ANSI.yellow : ANSI.dim,
      color,
    );
    const gateway = pad(report.gateway ? 'yes' : 'no', 7);
    lines.push(`${pad(report.engine, engineWidth)}  ${painted}  ${gateway}  ${stripControl(report.path) || '-'}`);
  }
  return lines.join('\n');
}
