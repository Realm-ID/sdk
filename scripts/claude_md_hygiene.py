#!/usr/bin/env python3
# VENDORED from claude-config skills/claude-md-hygiene @ 3948a59ff359 — edit canonical, not this copy
"""claude-md-hygiene: byte budgets and a history-text ban for every CLAUDE.md in a repo.

Spec: ~/.claude/skills/claude-md-hygiene/SKILL.md.  Stdlib only.

    python3 scripts/claude_md_hygiene.py [--root DIR] [--config FILE]
    python3 scripts/claude_md_hygiene.py --self-test

Checks: CM1 a file over its byte budget (root vs nested); CM2 a history-shaped line (prior
version, "until <date|version>", "said ... until", a GitHub Actions run id) not covered by a
waiver; CM3 a waiver that matched nothing.

Why: every CLAUDE.md on the path to the cwd is loaded before a session does any work, and
"current state only" written as prose failed twice in RealmID (2026-08-27, 2026-10-17).

Notes:
  * Budgets are bytes (os.path.getsize == `wc -c`), so CM1 is exact. CM1 cannot be waived: the
    owner ruled out temporary higher budgets; the fix is a trim or a reviewed config change.
  * The patterns are deliberately narrow; a line kept on purpose gets a waiver with a reason, and
    a waiver whose text is gone is CM3 so waivers cannot outlive what they excuse.
  * --self-test: an UNSTAMPED copy fails unless it sits directly in .../skills/claude-md-hygiene/
    scripts/ (canonical); a stamped copy fails when its content no longer hashes to its stamp.
    `vendor.sh --check` against canonical is the authoritative drift check.
"""

import argparse
import fnmatch
import hashlib
import json
import os
import re
import subprocess
import sys

STAMP_PREFIX = '# VENDORED from claude-config skills/claude-md-hygiene @'
CANONICAL_DIR = '/skills/claude-md-hygiene/scripts'
CONFIG_NAME = '.claude-md-hygiene.json'

DEFAULT_BUDGETS = {'root': 30000, 'nested': 12000}
CONFIG_KEYS = {'budgets', 'nested_repos', 'exclude', 'waivers'}
WAIVER_KEYS = {'check', 'path', 'match', 'reason'}
NAMES = ('CLAUDE.md', 'CLAUDE.local.md')
ROOT_FILES = ('CLAUDE.md', 'CLAUDE.local.md', '.claude/CLAUDE.md')
SKIP_DIRS = {'.git', 'node_modules', '.scratch', '.worktrees'}

HISTORY = [
    ('a prior version', re.compile(r'(?i)\b(?:prior|previously|formerly)[\s:(]+v?\d+\.\d+\.\d+')),
    ('"until" a date or version', re.compile(r'(?i)\buntil\s+(?:\d{4}-\d{2}-\d{2}|v\d+\.\d+)')),
    ('"said ... until"', re.compile(r'(?i)\bsaid\b.{0,80}?\buntil\b')),
    ('a GitHub Actions run id', re.compile(r'(?i)(?:\bruns?(?:\s+id)?\s*[#:]?\s*|actions/runs/)\d{10,}\b')),
]


class ConfigError(Exception):
    pass


def load_config(path):
    try:
        with open(path, encoding='utf-8') as f:
            raw = json.load(f)
    except FileNotFoundError:
        raise ConfigError('%s is absent — the checker needs it (see SKILL.md)' % path)
    except (OSError, ValueError) as e:
        raise ConfigError('%s: %s' % (path, e))
    if not isinstance(raw, dict):
        raise ConfigError('config must be a JSON object')
    unknown = set(raw) - CONFIG_KEYS
    if unknown:
        raise ConfigError('unknown key(s): %s' % ', '.join(sorted(unknown)))

    budgets = dict(DEFAULT_BUDGETS)
    b = raw.get('budgets', {})
    if not isinstance(b, dict):
        raise ConfigError('budgets must be an object')
    for k, v in b.items():
        if k not in DEFAULT_BUDGETS:
            raise ConfigError('unknown budgets key: %s' % k)
        if isinstance(v, bool) or not isinstance(v, int) or v <= 0:
            raise ConfigError('budgets.%s must be a positive integer (bytes)' % k)
        budgets[k] = v

    nested = raw.get('nested_repos', 'scan')
    if nested not in ('scan', 'skip'):
        raise ConfigError('nested_repos must be "scan" or "skip"')

    exclude = raw.get('exclude', [])
    if not isinstance(exclude, list) or not all(isinstance(g, str) for g in exclude):
        raise ConfigError('exclude must be a list of globs')

    waivers = raw.get('waivers', [])
    if not isinstance(waivers, list):
        raise ConfigError('waivers must be a list')
    for i, w in enumerate(waivers):
        if not isinstance(w, dict) or set(w) != WAIVER_KEYS:
            raise ConfigError('waivers[%d] needs exactly the keys %s' % (i, ', '.join(sorted(WAIVER_KEYS))))
        if not all(isinstance(w[k], str) and w[k].strip() for k in WAIVER_KEYS):
            raise ConfigError('waivers[%d]: every key needs non-empty text — a waiver without a reason '
                              'is not allowed' % i)
        if w['check'] != 'CM2':
            raise ConfigError('waivers[%d]: only CM2 can be waived (CM1: trim the file or change '
                              'budgets in review)' % i)
    return {'budgets': budgets, 'nested_repos': nested, 'exclude': exclude, 'waivers': waivers}


def ignored_dirs(root):
    """Gitignored directories under root, as rel paths; empty when root is not in a git work tree.
    Only DIRECTORIES: a gitignored CLAUDE.local.md still loads into every session, so it is checked."""
    env = {k: v for k, v in os.environ.items() if not k.startswith('GIT_')}  # hooks export GIT_DIR
    try:
        out = subprocess.run(['git', '-C', root, 'ls-files', '--others', '--ignored',
                              '--exclude-standard', '--directory', '-z'],
                             env=env, capture_output=True, check=True).stdout
    except (OSError, subprocess.CalledProcessError):
        return set()
    return {p.decode('utf-8', 'replace').rstrip('/') for p in out.split(b'\0') if p.endswith(b'/')}


def find_files(root, cfg):
    """Returns (files, nested_repos_skipped, ignored_dirs_skipped); files are (rel_path, kind) with
    kind root|nested."""
    files, skipped, ignored_skipped = [], 0, 0
    ignored = ignored_dirs(root)
    for d, dirs, names in os.walk(root):
        keep = []
        for name in sorted(dirs):
            if name in SKIP_DIRS:
                continue
            sub = os.path.join(d, name)
            # a nested repo (an umbrella's gitignored service clone) is governed by nested_repos alone
            if os.path.exists(os.path.join(sub, '.git')):
                if cfg['nested_repos'] == 'skip':
                    skipped += 1
                    continue
            elif os.path.relpath(sub, root).replace(os.sep, '/') in ignored:
                ignored_skipped += 1
                continue
            keep.append(name)
        dirs[:] = keep
        for name in sorted(names):
            if name not in NAMES:
                continue
            rel = os.path.relpath(os.path.join(d, name), root).replace(os.sep, '/')
            if any(fnmatch.fnmatch(rel, g) for g in cfg['exclude']):
                continue
            files.append((rel, 'root' if rel in ROOT_FILES else 'nested'))
    return files, skipped, ignored_skipped


def check(root, cfg):
    """Returns (summary_line, findings) where findings are (check, rel, line, message)."""
    files, skipped, ignored_skipped = find_files(root, cfg)
    findings, waived, used = [], 0, set()
    for rel, kind in files:
        path = os.path.join(root, rel)
        size = os.path.getsize(path)
        budget = cfg['budgets'][kind]
        if size > budget:
            findings.append(('CM1', rel, 1, '%d bytes > budget %d (%s) — keep current state only; move '
                             'history to DECISIONS.md or a ledger' % (size, budget, kind)))
        with open(path, encoding='utf-8', errors='replace') as f:
            lines = f.read().split('\n')
        for n, text in enumerate(lines, 1):
            hit = next((label for label, rx in HISTORY if rx.search(text)), None)
            if not hit:
                continue
            w = next((i for i, w in enumerate(cfg['waivers'])
                      if fnmatch.fnmatch(rel, w['path']) and w['match'] in text), None)
            if w is not None:
                waived += 1
                used.add(w)
                continue
            findings.append(('CM2', rel, n, 'history-shaped text (%s): %s — state what is true now, '
                             'or waive with a reason' % (hit, text.strip()[:120])))
    for i, w in enumerate(cfg['waivers']):
        if i not in used:
            findings.append(('CM3', CONFIG_NAME, 1, 'waiver %d (%s, %r) matched nothing — remove it'
                             % (i, w['path'], w['match'])))
    n_root = sum(1 for _, k in files if k == 'root')
    summary = ('examined: %d files (%d root, %d nested, %d waived, %d nested repos skipped, '
               '%d gitignored dirs skipped)') % (
        len(files), n_root, len(files) - n_root, waived, skipped, ignored_skipped)
    return summary, len(files), sorted(findings, key=lambda f: (f[1], f[2], f[0]))


def is_canonical_path(path):
    d = os.path.dirname(os.path.realpath(path)).replace(os.sep, '/')
    return d.endswith(CANONICAL_DIR)


SELF_TEST_FAIL = ('self-test: FAIL content does not match its stamp; re-vendor from canonical '
                  '(vendor.sh), never edit or re-stamp a copy')


def self_test(path=None):
    path = path or os.path.abspath(__file__)
    with open(path, encoding='utf-8') as f:
        lines = f.read().replace('\r', '').split('\n')
    at = 1 if lines[0].startswith('#!') else 0
    if at >= len(lines) or not lines[at].startswith(STAMP_PREFIX):
        if is_canonical_path(path):
            print('self-test: canonical (unstamped) copy; nothing to verify')
            return 0
        print(SELF_TEST_FAIL)
        return 1
    stamped = lines[at][len(STAMP_PREFIX):].strip()[:12]
    actual = hashlib.sha256('\n'.join(lines[:at] + lines[at + 1:]).encode('utf-8')).hexdigest()[:12]
    if stamped != actual:
        print(SELF_TEST_FAIL)  # never print the actual hash: it would invite re-stamping
        return 1
    print('self-test: ok (stamp @%s matches content)' % stamped)
    return 0


def main(argv):
    ap = argparse.ArgumentParser(prog='claude_md_hygiene.py')
    ap.add_argument('--root', default='.')
    ap.add_argument('--config')
    ap.add_argument('--self-test', action='store_true')
    try:
        args = ap.parse_args(argv)
    except SystemExit:
        return 2
    if args.self_test:
        return self_test()
    root = os.path.abspath(args.root)
    try:
        cfg = load_config(args.config or os.path.join(root, CONFIG_NAME))
    except ConfigError as e:
        print('error: %s' % e)
        return 2
    summary, examined, findings = check(root, cfg)
    print(summary)
    for c, rel, n, msg in findings:
        print('%s %s:%d: %s' % (c, rel, n, msg))
    if examined == 0:
        print('error: nothing was checked — no CLAUDE.md under %s' % root)
        return 2
    return 1 if findings else 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
