#!/usr/bin/env python3
# VENDORED from claude-config skills/claude-md-hygiene @ b7892028ceed — edit canonical, not this copy
"""claude-md-hygiene: byte budgets and a history-text ban for every CLAUDE.md in a repo.

Spec: ~/.claude/skills/claude-md-hygiene/SKILL.md.  Stdlib only.

    python3 scripts/claude_md_hygiene.py [--root DIR] [--config FILE]
    python3 scripts/claude_md_hygiene.py --self-test

Checks: CM1 a file over its byte budget (root vs nested); CM2 a history-shaped line (prior
version, "until <date|version>", "said ... until", a GitHub Actions run id) not covered by a
waiver; CM3 a waiver that matched nothing; CM4 a pointer that does not resolve (a relative
markdown link to a missing file or #anchor, or "<path>.md §X" / "<alias> §X" naming no heading).

Why: every CLAUDE.md on the path to the cwd is loaded before a session does any work, and
"current state only" written as prose failed twice in RealmID (2026-08-27, 2026-10-17).

Notes:
  * Budgets are bytes (os.path.getsize == `wc -c`), so CM1 is exact. CM1 cannot be waived: the
    owner ruled out temporary higher budgets; the fix is a trim or a reviewed config change.
  * The patterns are deliberately narrow; a line kept on purpose gets a waiver with a reason, and
    a waiver whose text is gone is CM3 so waivers cannot outlive what they excuse.
  * CM4 exists because a trimmed CLAUDE.md keeps one-line summaries that point at a detail doc
    (Traide, 2026-10-18): a renamed or deleted section left the pointer dangling and CI green. A
    target outside --root, or missing under a gitignored path (an umbrella's unchecked-out service
    clone), cannot be judged here: it is counted as "unresolvable here", never a finding.
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
from urllib.parse import unquote

STAMP_PREFIX = '# VENDORED from claude-config skills/claude-md-hygiene @'
CANONICAL_DIR = '/skills/claude-md-hygiene/scripts'
CONFIG_NAME = '.claude-md-hygiene.json'

DEFAULT_BUDGETS = {'root': 30000, 'nested': 12000}
CONFIG_KEYS = {'budgets', 'nested_repos', 'exclude', 'waivers', 'pointer_aliases'}
WAIVABLE = ('CM2', 'CM4')
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

FENCE = re.compile(r'^\s*(```|~~~)')
HEADING = re.compile(r'^#{1,6}\s+(.*?)\s*#*\s*$')
CODE_SPAN = re.compile(r'`[^`\n]*`')
LINK = re.compile(r'\]\(\s*<?([^)\s>]*)>?(?:\s+"[^"]*")?\s*\)')
SCHEME = re.compile(r'^[a-zA-Z][a-zA-Z0-9+.-]*:')
# "<path>.md §X", with the path bare, in backticks, or as a markdown link target; ~/ and / paths
# are the laptop's, not the repo's, so the lookbehind refuses a path that continues one
PATH_SECTION = re.compile(r'(?:\]\(([^)\s#]+\.md)\)|`?(?<![\w~/.-])([\w.-][\w./-]*\.md)`?)\s*§\s*')
# a code span holding nothing but a relative .md path: `docs/x.md`, `CHANGELOG.md`; a placeholder,
# glob, command, URL, ~/ or absolute path fails the character class, so it is not a pointer
BARE_PATH = re.compile(r'`([\w.-][\w./-]*\.md)`')
LINK_TEXT = re.compile(r'\[[^\]\n]*\]\(')
SECTION_STOP = re.compile(r'[.,;:()\[\]`"…]| §')
NUMBERING = re.compile(r'^\d+(?:\.\d+)*\.?\s+')


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
        if w['check'] not in WAIVABLE:
            raise ConfigError('waivers[%d]: only %s can be waived (CM1: trim the file or change '
                              'budgets in review)' % (i, ' and '.join(WAIVABLE)))

    aliases = raw.get('pointer_aliases', {})
    if not isinstance(aliases, dict) or not all(
            isinstance(k, str) and re.fullmatch(r'\w+', k) and isinstance(v, str) and v.strip()
            for k, v in aliases.items()):
        raise ConfigError('pointer_aliases must map a word to a doc path, e.g. '
                          '{"detail": "docs/claude-md-detail.md"}')
    return {'budgets': budgets, 'nested_repos': nested, 'exclude': exclude, 'waivers': waivers,
            'pointer_aliases': aliases}


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


def unfenced(lines):
    """Yields (line_no, text) for the lines outside fenced code blocks."""
    fenced = False
    for n, text in enumerate(lines, 1):
        if FENCE.match(text):
            fenced = not fenced
        elif not fenced:
            yield n, text


def norm(text):
    text = re.sub(r'[*_`"“”]', '', text).replace('—', '-').replace('–', '-')
    return ' '.join(text.split()).lower().lstrip('§').strip()


def slug(text):
    """GitHub's heading anchor: lowercase, punctuation dropped, each space a hyphen."""
    return re.sub(r'[^\w\- ]', '', text.strip().lower()).replace(' ', '-')


class Pointers:
    """Resolves CM4 pointers; caches each target's headings. Tallies checked and unresolvable."""

    def __init__(self, root, aliases):
        self.root, self.aliases, self.cache = root, aliases, {}
        self.checked = self.unresolvable = 0
        self.alias_rx = (re.compile(r'(?i)\b(%s)\s*§\s*' % '|'.join(map(re.escape, aliases)))
                         if aliases else None)

    def headings(self, path):
        if path not in self.cache:
            with open(path, encoding='utf-8', errors='replace') as f:
                lines = f.read().split('\n')
            texts = [m.group(1) for _, t in unfenced(lines) for m in [HEADING.match(t)] if m]
            slugs, seen = set(), {}
            for t in texts:  # GitHub suffixes a repeated heading's anchor with -1, -2 ...
                s = slug(t)
                slugs.add(s if s not in seen else '%s-%d' % (s, seen[s]))
                seen[s] = seen.get(s, 0) + 1
            self.cache[path] = ([norm(t) for t in texts], slugs)
        return self.cache[path]

    def ignored(self, path):
        env = {k: v for k, v in os.environ.items() if not k.startswith('GIT_')}
        rel = os.path.relpath(path, self.root)
        return subprocess.run(['git', '-C', self.root, 'check-ignore', '-q', rel], env=env,
                              stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0

    def locate(self, candidates):
        """Returns (path, None) when found, (None, None) when it cannot be judged here, or
        (None, message) when it is missing."""
        inside = [p for p in candidates
                  if os.path.realpath(p).startswith(os.path.realpath(self.root) + os.sep)]
        for p in inside:
            if os.path.exists(p):
                return p, None
        if not inside or any(self.ignored(p) for p in inside):
            self.unresolvable += 1
            return None, None
        return None, 'no such file: %s' % os.path.relpath(inside[0], self.root)

    def section(self, path, sec, to_eol):
        """Message when no heading in path matches section text sec, else None."""
        heads, _ = self.headings(path)
        if sec[0].isdigit():
            rx = re.compile(re.escape(sec) + r'(?![\d]|\.\d)')
            ok = any(rx.match(h) for h in heads)
        else:
            # the pointer starts the heading ("§Stack" -> "Stack and layout"), or the heading's own
            # title, cut before its first "(" or ":", starts the pointer, which then runs on into
            # prose ("§ Post-release obligations is authoritative" -> "Post-release obligations
            # (opened ...)")
            s = norm(sec)
            ok = False
            for head in heads:
                for h in (head, NUMBERING.sub('', head)):
                    core = SECTION_STOP.split(h, maxsplit=1)[0].strip()
                    if (h.startswith(s) and (to_eol or len(h) == len(s) or not h[len(s)].isalnum())) \
                            or (core and (s == core or s.startswith(core + ' '))):
                        ok = True
        return None if ok else 'no heading "%s" in %s' % (sec, os.path.relpath(path, self.root))

    def check_line(self, base, path_self, text):
        """Yields one message per pointer on the line that does not resolve."""
        for m in LINK.finditer(CODE_SPAN.sub('', text)):
            target = m.group(1)
            if not target or SCHEME.match(target) or target[0] in '/~':
                continue
            self.checked += 1
            file_part, _, anchor = target.partition('#')
            if file_part:
                found, msg = self.locate([os.path.join(base, unquote(file_part))])
                if msg:
                    yield msg
                    continue
            else:
                found = path_self
            if found and anchor and os.path.isfile(found) and found.endswith('.md') \
                    and unquote(anchor).lower() not in self.headings(found)[1]:
                yield 'no heading with anchor #%s in %s' % (anchor, os.path.relpath(found, self.root))
        refs = [(m, [os.path.join(base, m.group(1) or m.group(2)),
                     os.path.join(self.root, m.group(1) or m.group(2))])
                for m in PATH_SECTION.finditer(text)]
        if self.alias_rx:
            refs += [(m, [os.path.join(base, self.aliases[next(a for a in self.aliases
                                                                if a.lower() == m.group(1).lower())])])
                     for m in self.alias_rx.finditer(text)]
        for m, candidates in refs:
            rest = text[m.end():]
            if rest[:1] in '"“':
                sec, to_eol = re.split(r'["”]', rest[1:], maxsplit=1)[0], False
            elif rest[:1].isdigit():
                sec, to_eol = re.match(r'\d+(?:\.\d+)*', rest).group(0), False
            else:
                stop = SECTION_STOP.search(rest)
                sec, to_eol = (rest[:stop.start()] if stop else rest).strip(), stop is None
            if not sec or sec.startswith('<'):  # a placeholder: 'cited as "detail §<heading>"'
                continue
            self.checked += 1
            found, msg = self.locate(list(dict.fromkeys(candidates)))
            if msg:
                yield msg
            elif found and os.path.isfile(found):
                msg = self.section(found, sec, to_eol)
                if msg:
                    yield msg
        link_texts = [m.span() for m in LINK_TEXT.finditer(text)]
        for m in BARE_PATH.finditer(text):
            # a link's text (the link is checked) and "`x.md` §S" (checked above) count once
            if any(a <= m.start() and m.end() <= b for a, b in link_texts) \
                    or re.match(r'\s*§', text[m.end():]):
                continue
            rel = m.group(1)
            self.checked += 1
            first = rel.split('/')[0] if '/' in rel else None
            if first not in (None, '.', '..') and not any(
                    os.path.exists(os.path.join(d, first)) for d in (base, self.root)):
                self.unresolvable += 1  # someone else's tree: `issuer/docs/x.md` from the ui repo
                continue
            _, msg = self.locate(list(dict.fromkeys([os.path.join(base, rel),
                                                     os.path.join(self.root, rel)])))
            if msg:
                yield msg


def check(root, cfg):
    """Returns (summary_line, findings) where findings are (check, rel, line, message)."""
    files, skipped, ignored_skipped = find_files(root, cfg)
    findings, waived, used = [], 0, set()
    pointers = Pointers(root, cfg['pointer_aliases'])

    def waiver(check_id, rel, text):
        return next((i for i, w in enumerate(cfg['waivers'])
                     if w['check'] == check_id and fnmatch.fnmatch(rel, w['path'])
                     and w['match'] in text), None)

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
            w = waiver('CM2', rel, text)
            if w is not None:
                waived += 1
                used.add(w)
                continue
            findings.append(('CM2', rel, n, 'history-shaped text (%s): %s — state what is true now, '
                             'or waive with a reason' % (hit, text.strip()[:120])))
        for n, text in unfenced(lines):
            for msg in pointers.check_line(os.path.dirname(path), path, text):
                w = waiver('CM4', rel, text)
                if w is not None:
                    waived += 1
                    used.add(w)
                    continue
                findings.append(('CM4', rel, n, 'pointer does not resolve (%s) — fix the pointer, '
                                 'or waive with a reason' % msg))
    for i, w in enumerate(cfg['waivers']):
        if i not in used:
            findings.append(('CM3', CONFIG_NAME, 1, 'waiver %d (%s, %r) matched nothing — remove it'
                             % (i, w['path'], w['match'])))
    n_root = sum(1 for _, k in files if k == 'root')
    summary = ('examined: %d files (%d root, %d nested, %d waived, %d nested repos skipped, '
               '%d gitignored dirs skipped); %d pointers checked, %d unresolvable here') % (
        len(files), n_root, len(files) - n_root, waived, skipped, ignored_skipped,
        pointers.checked, pointers.unresolvable)
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
