/**
 * D7: the error taxonomy.
 *
 * Exit codes are a contract. A code is never reused for a different meaning, and an
 * unclassified failure exits 1 and is a bug in the wrapper. Each class carries a
 * remedy string; a class with no remedy is incomplete and fails its own test.
 *
 * Code 7 is `E_CMUX_INCOMPATIBLE`, not a build-identity check. A build that differs from
 * the fixture build but answers every method we call is not unusable, so a bare build
 * difference produces a warning, never a refusal. Refusal is for a missing capability or
 * a build below the declared minimum.
 */

export const ERROR_CLASSES = {
  E_INTERNAL: {
    code: 1,
    meaning: 'uncaught, unclassified failure inside grove-cmux',
    remedy: 'report this with the stack trace above',
  },
  E_USAGE: {
    code: 2,
    meaning: 'bad flag, missing argument, or unknown command',
    remedy: 'run grove-cmux --help',
  },
  E_CMUX_UNAVAILABLE: {
    code: 3,
    meaning: 'no cmux control socket; cmux is not running or the socket is gone',
    remedy: 'start cmux, then retry',
  },
  E_CMUX_AUTH: {
    code: 4,
    meaning: 'cmux rejected the socket password, or no password is set',
    remedy: 'set CMUX_SOCKET_PASSWORD, or arm the password in cmux Settings, then retry',
  },
  E_CMUX_TARGET: {
    code: 5,
    meaning: 'the window, group, or workspace you named does not exist here',
    remedy: 'run grove-cmux status to list the windows and ids that do exist',
  },
  E_CMUX_RPC: {
    code: 6,
    meaning: 'an RPC call failed for a reason grove-cmux does not classify',
    remedy: 'check the evidence below; if cmux is healthy, report this',
  },
  E_CMUX_INCOMPATIBLE: {
    code: 7,
    meaning: 'this cmux build is missing a method grove-cmux calls, or is below the minimum',
    remedy: 'upgrade cmux to the minimum build named in the evidence',
  },
  E_GROVE_FAILED: {
    code: 8,
    meaning: 'grove exited non-zero',
    remedy: 'run the grove command in the evidence directly and fix what it reports',
  },
  E_GROVE_SCHEMA: {
    code: 9,
    meaning: 'grove emitted JSON whose schemaVersion grove-cmux does not understand',
    remedy: 'upgrade grove-cmux, or pin grove to a supported schemaVersion',
  },
  E_LEDGER: {
    code: 10,
    meaning: 'the projection ledger is unreadable, unparsable, or written by a newer schema',
    remedy: 'upgrade grove-cmux; do not delete the ledger, it is the only record of ownership',
  },
  E_AMBIGUOUS_TARGET: {
    code: 11,
    meaning: 'more than one candidate and nothing named which one',
    remedy: 'pass --window <id> to name the target',
  },
  E_PRECONDITION: {
    code: 12,
    meaning: 'the world cannot host this command',
    remedy: 'check the path in the evidence exists and is a Grove',
  },
  E_PROJECTION_CONFLICT: {
    code: 13,
    meaning: 'this Grove is already projected in another window, or its recorded window is gone',
    remedy: 'run against the window named in the evidence, or pass --relocate to re-project here',
  },
} as const;

export type ErrorClass = keyof typeof ERROR_CLASSES;

export type Evidence = Record<string, unknown>;

export class GroveCmuxError extends Error {
  readonly cls: ErrorClass;
  readonly code: number;
  readonly evidence: Evidence;
  readonly remedy: string;

  constructor(cls: ErrorClass, message: string, evidence: Evidence = {}, remedy?: string) {
    super(message);
    this.name = 'GroveCmuxError';
    this.cls = cls;
    this.code = ERROR_CLASSES[cls].code;
    this.evidence = evidence;
    this.remedy = remedy ?? ERROR_CLASSES[cls].remedy;
  }

  toJSON() {
    return {
      schema: 'grove-cmux.error/1',
      class: this.cls,
      exit_code: this.code,
      message: this.message,
      evidence: this.evidence,
      remedy: this.remedy,
    };
  }

  /** Human form: class line, evidence block, remedy line. AC-13's three parts. */
  toHuman(): string {
    const lines = [`error: ${this.cls} (${this.code}): ${this.message}`];
    const keys = Object.keys(this.evidence);
    if (keys.length > 0) {
      lines.push('evidence:');
      for (const k of keys) {
        lines.push(`  ${k}: ${formatEvidenceValue(this.evidence[k])}`);
      }
    }
    lines.push(`try: ${this.remedy}`);
    return lines.join('\n');
  }
}

function formatEvidenceValue(v: unknown): string {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return JSON.stringify(v);
}

export function isGroveCmuxError(e: unknown): e is GroveCmuxError {
  return e instanceof GroveCmuxError;
}
