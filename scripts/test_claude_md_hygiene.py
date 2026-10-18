#!/usr/bin/env python3
# VENDORED from claude-config skills/claude-md-hygiene @ a4f64b245ded — edit canonical, not this copy
"""Tests for claude_md_hygiene.py -- stdlib only, unittest. Spec: ~/.claude/skills/claude-md-hygiene/SKILL.md

INTERFACE ASSUMED OF claude_md_hygiene.py:

  main(argv: list[str]) -> int     prints to stdout; flags --root DIR, --config FILE, --self-test
  load_config(path) -> cfg         raises ConfigError on a bad config
  class ConfigError(Exception)

Output contract: first line `examined: N files (R root, M nested, W waived, S nested repos skipped, G gitignored dirs skipped); P pointers checked, U unresolvable here`,
then `CMn path:line: message` per finding. Exit 0 clean / 1 findings / 2 config-usage error or
nothing examined.

Run:  python3 test_claude_md_hygiene.py
"""

import contextlib
import hashlib
import io
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import claude_md_hygiene as cmh  # noqa: E402


class Repo:
    def __init__(self):
        self.root = tempfile.mkdtemp(prefix='cmh-test-')

    def write(self, rel, text):
        p = os.path.join(self.root, rel)
        os.makedirs(os.path.dirname(p), exist_ok=True)
        with open(p, 'w', encoding='utf-8') as f:
            f.write(text)
        return p

    def config(self, **cfg):
        self.write('.claude-md-hygiene.json', json.dumps(cfg))

    def run(self, *extra):
        out = io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(io.StringIO()):
            rc = cmh.main(['--root', self.root] + list(extra))
        return rc, out.getvalue()

    def cleanup(self):
        shutil.rmtree(self.root, ignore_errors=True)


CLEAN = '# CLAUDE.md\n\nCurrent state only.\n'


class Base(unittest.TestCase):
    def setUp(self):
        self.r = Repo()
        self.addCleanup(self.r.cleanup)


class TestBudget(Base):
    def test_under_budget_is_clean(self):
        self.r.config(budgets={'root': 100, 'nested': 50})
        self.r.write('CLAUDE.md', 'x' * 100)
        rc, out = self.r.run()
        self.assertEqual(rc, 0, out)
        self.assertTrue(out.startswith('examined: 1 files (1 root, 0 nested'), out)

    def test_root_over_budget_fails(self):
        self.r.config(budgets={'root': 100, 'nested': 50})
        self.r.write('CLAUDE.md', 'x' * 101)
        rc, out = self.r.run()
        self.assertEqual(rc, 1, out)
        self.assertIn('CM1 CLAUDE.md:1: 101 bytes > budget 100 (root)', out)

    def test_nested_uses_nested_budget(self):
        self.r.config(budgets={'root': 100, 'nested': 50})
        self.r.write('CLAUDE.md', CLEAN)
        self.r.write('issuer/CLAUDE.md', 'x' * 51)
        rc, out = self.r.run()
        self.assertEqual(rc, 1, out)
        self.assertIn('CM1 issuer/CLAUDE.md:1: 51 bytes > budget 50 (nested)', out)

    def test_local_and_dot_claude_are_root(self):
        self.r.config(budgets={'root': 100, 'nested': 10})
        self.r.write('CLAUDE.local.md', 'x' * 60)
        self.r.write('.claude/CLAUDE.md', 'x' * 60)
        rc, out = self.r.run()
        self.assertEqual(rc, 0, out)
        self.assertIn('examined: 2 files (2 root, 0 nested', out)

    def test_default_budgets(self):
        self.r.config()
        self.r.write('CLAUDE.md', 'x' * 30001)
        self.r.write('a/CLAUDE.md', 'x' * 12000)
        rc, out = self.r.run()
        self.assertEqual(rc, 1, out)
        self.assertIn('30001 bytes > budget 30000 (root)', out)
        self.assertNotIn('a/CLAUDE.md', out)


class TestHistory(Base):
    def check_line(self, line, expect_fail=True):
        self.r.config()
        self.r.write('CLAUDE.md', CLEAN + line + '\n')
        rc, out = self.r.run()
        if expect_fail:
            self.assertEqual(rc, 1, out)
            self.assertIn('CM2 CLAUDE.md:4:', out)
        else:
            self.assertEqual(rc, 0, out)
        return out

    def test_prior_semver(self):
        self.check_line('Prior v1.2.3 shipped without the guard.')

    def test_previously_semver(self):
        self.check_line('The sdk was previously v0.9.1 on stage.')

    def test_until_iso_date(self):
        self.check_line('Stage used the old issuer until 2026-09-30.')

    def test_until_version(self):
        self.check_line('The cookie was host-only until v0.39.0.')

    def test_said_until(self):
        self.check_line('The README said port 8080 until the rename.')

    def test_run_id(self):
        self.check_line('Proven green in run 38929730827.')

    def test_run_id_url(self):
        self.check_line('See https://github.com/o/r/actions/runs/39012830258 for proof.')

    def test_current_state_is_clean(self):
        # Positive control for the patterns: near-misses that ARE current state.
        for line in ('Pin v1.2.3 in consumers.',
                     'Wait until the job finishes.',
                     'Run `make check` before pushing; it takes 12 seconds.',
                     'Owner ruling 2026-10-17: RI first.'):
            with self.subTest(line=line):
                self.check_line(line, expect_fail=False)

    def test_reports_line_number_of_each_hit(self):
        self.r.config()
        self.r.write('CLAUDE.md', 'a\nPrior v1.0.0\nb\nrun 12345678901\n')
        rc, out = self.r.run()
        self.assertIn('CM2 CLAUDE.md:2:', out)
        self.assertIn('CM2 CLAUDE.md:4:', out)


class TestWaivers(Base):
    def test_waiver_with_reason_excuses_line(self):
        self.r.config(waivers=[{'check': 'CM2', 'path': 'CLAUDE.md', 'match': 'Prior v1.2.3',
                                'reason': 'migration note readers still need'}])
        self.r.write('CLAUDE.md', CLEAN + 'Prior v1.2.3 stays.\n')
        rc, out = self.r.run()
        self.assertEqual(rc, 0, out)
        self.assertIn('1 waived', out)

    def test_waiver_without_reason_is_exit_2(self):
        self.r.config(waivers=[{'check': 'CM2', 'path': 'CLAUDE.md', 'match': 'Prior', 'reason': ' '}])
        self.r.write('CLAUDE.md', CLEAN)
        rc, out = self.r.run()
        self.assertEqual(rc, 2, out)

    def test_waiver_missing_key_is_exit_2(self):
        self.r.config(waivers=[{'check': 'CM2', 'path': 'CLAUDE.md', 'reason': 'x'}])
        self.r.write('CLAUDE.md', CLEAN)
        self.assertEqual(self.r.run()[0], 2)

    def test_budget_waiver_is_exit_2(self):
        self.r.config(waivers=[{'check': 'CM1', 'path': 'CLAUDE.md', 'match': 'x', 'reason': 'big'}])
        self.r.write('CLAUDE.md', CLEAN)
        self.assertEqual(self.r.run()[0], 2)

    def test_unused_waiver_is_cm3(self):
        self.r.config(waivers=[{'check': 'CM2', 'path': 'CLAUDE.md', 'match': 'Prior v9.9.9',
                                'reason': 'gone now'}])
        self.r.write('CLAUDE.md', CLEAN)
        rc, out = self.r.run()
        self.assertEqual(rc, 1, out)
        self.assertIn('CM3', out)

    def test_waiver_path_must_match(self):
        self.r.config(waivers=[{'check': 'CM2', 'path': 'other/CLAUDE.md', 'match': 'Prior v1.2.3',
                                'reason': 'r'}])
        self.r.write('CLAUDE.md', CLEAN + 'Prior v1.2.3\n')
        rc, out = self.r.run()
        self.assertIn('CM2 CLAUDE.md:4:', out)
        self.assertIn('CM3', out)


class TestConfig(Base):
    def test_missing_config_is_exit_2(self):
        self.r.write('CLAUDE.md', CLEAN)
        self.assertEqual(self.r.run()[0], 2)

    def test_unknown_key_is_exit_2(self):
        self.r.config(budget={'root': 1})
        self.r.write('CLAUDE.md', CLEAN)
        self.assertEqual(self.r.run()[0], 2)

    def test_unknown_budget_key_is_exit_2(self):
        self.r.config(budgets={'root': 1, 'global': 5})
        self.r.write('CLAUDE.md', CLEAN)
        self.assertEqual(self.r.run()[0], 2)

    def test_bad_budget_value_is_exit_2(self):
        for bad in (0, -1, '30000', 1.5, True):
            with self.subTest(bad=bad):
                self.r.config(budgets={'root': bad})
                self.r.write('CLAUDE.md', CLEAN)
                self.assertEqual(self.r.run()[0], 2)

    def test_bad_nested_repos_value_is_exit_2(self):
        self.r.config(nested_repos='maybe')
        self.r.write('CLAUDE.md', CLEAN)
        self.assertEqual(self.r.run()[0], 2)

    def test_corrupt_json_is_exit_2(self):
        self.r.write('.claude-md-hygiene.json', '{not json')
        self.r.write('CLAUDE.md', CLEAN)
        self.assertEqual(self.r.run()[0], 2)

    def test_load_config_raises(self):
        p = self.r.write('c.json', json.dumps({'nope': 1}))
        with self.assertRaises(cmh.ConfigError):
            cmh.load_config(p)

    def test_explicit_config_path(self):
        p = self.r.write('cfg/x.json', json.dumps({'budgets': {'root': 5}}))
        self.r.write('CLAUDE.md', CLEAN)
        rc, out = self.r.run('--config', p)
        self.assertEqual(rc, 1, out)


class TestScan(Base):
    def test_nothing_examined_is_exit_2(self):
        self.r.config()
        rc, out = self.r.run()
        self.assertEqual(rc, 2, out)
        self.assertTrue(out.startswith('examined: 0 files'), out)

    def test_skipped_dirs(self):
        self.r.config()
        self.r.write('CLAUDE.md', CLEAN)
        for d in ('.scratch', '.worktrees', 'node_modules', '.git', 'a/node_modules', 'b/.scratch'):
            self.r.write(d + '/CLAUDE.md', 'Prior v1.0.0\n')
        rc, out = self.r.run()
        self.assertEqual(rc, 0, out)
        self.assertIn('examined: 1 files', out)

    def test_exclude_glob(self):
        self.r.config(exclude=['vendor/*'])
        self.r.write('CLAUDE.md', CLEAN)
        self.r.write('vendor/x/CLAUDE.md', 'Prior v1.0.0\n')
        rc, out = self.r.run()
        self.assertEqual(rc, 0, out)

    def test_nested_repos_scanned_by_default(self):
        self.r.config()
        self.r.write('CLAUDE.md', CLEAN)
        os.makedirs(os.path.join(self.r.root, 'issuer', '.git'))
        self.r.write('issuer/CLAUDE.md', 'Prior v1.0.0\n')
        rc, out = self.r.run()
        self.assertEqual(rc, 1, out)
        self.assertIn('CM2 issuer/CLAUDE.md:1:', out)
        self.assertIn('1 nested,', out)

    def test_nested_repos_skip(self):
        self.r.config(nested_repos='skip')
        self.r.write('CLAUDE.md', CLEAN)
        os.makedirs(os.path.join(self.r.root, 'issuer', '.git'))
        self.r.write('issuer/CLAUDE.md', 'Prior v1.0.0\n')
        rc, out = self.r.run()
        self.assertEqual(rc, 0, out)
        self.assertIn('1 nested repos skipped', out)

    def git(self, *args):
        # scrub GIT_DIR & co: a test run from inside a git hook would otherwise act on the hooked repo
        env = {k: v for k, v in os.environ.items() if not k.startswith('GIT_')}
        subprocess.run(['git', '-C', self.r.root] + list(args), env=env, check=True,
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

    def test_gitignored_dirs_skipped(self):
        self.r.config()
        self.git('init', '-q')
        self.r.write('.gitignore', '.prod-data/\n')
        self.r.write('CLAUDE.md', CLEAN)
        self.r.write('.prod-data/cap1/api/CLAUDE.md', 'Prior v1.0.0\n')
        self.r.write('.prod-data/cap2/api/CLAUDE.md', 'Prior v1.0.0\n')
        rc, out = self.r.run()
        self.assertEqual(rc, 0, out)
        self.assertIn('examined: 1 files', out)
        self.assertIn('1 gitignored dirs skipped', out)

    def test_gitignored_file_still_checked(self):
        # CLAUDE.local.md is gitignored by design and still loads into every session
        self.r.config()
        self.git('init', '-q')
        self.r.write('.gitignore', 'CLAUDE.local.md\n')
        self.r.write('CLAUDE.md', CLEAN)
        self.r.write('CLAUDE.local.md', 'Prior v1.0.0\n')
        rc, out = self.r.run()
        self.assertEqual(rc, 1, out)
        self.assertIn('CM2 CLAUDE.local.md:1:', out)

    def test_gitignored_nested_repo_follows_nested_repos(self):
        # an umbrella gitignores its service clones; nested_repos (default scan) still decides
        self.r.config()
        self.git('init', '-q')
        self.r.write('.gitignore', 'issuer/\n')
        self.r.write('CLAUDE.md', CLEAN)
        os.makedirs(os.path.join(self.r.root, 'issuer', '.git'))
        self.r.write('issuer/CLAUDE.md', 'Prior v1.0.0\n')
        rc, out = self.r.run()
        self.assertEqual(rc, 1, out)
        self.assertIn('CM2 issuer/CLAUDE.md:1:', out)
        self.assertIn('0 gitignored dirs skipped', out)

    def test_not_a_git_repo_skips_nothing(self):
        self.r.config()
        self.r.write('.gitignore', 'data/\n')
        self.r.write('CLAUDE.md', CLEAN)
        self.r.write('data/CLAUDE.md', CLEAN)
        rc, out = self.r.run()
        self.assertEqual(rc, 0, out)
        self.assertIn('examined: 2 files', out)
        self.assertIn('0 gitignored dirs skipped', out)

    def test_other_markdown_ignored(self):
        self.r.config()
        self.r.write('CLAUDE.md', CLEAN)
        self.r.write('DECISIONS.md', 'Prior v1.0.0 until 2026-01-01, run 12345678901\n')
        rc, out = self.r.run()
        self.assertEqual(rc, 0, out)


DOC = '# Doc\n\n## 2. Stack\n\n## 21 Other\n\n## Breaking changes\n\n## Service `Release gate`\n\n' \
      '## API contract — CI enforcement\n\n```\n## Not a heading\n```\n'


class TestPointers(Base):
    """CM4: a pointer from a CLAUDE.md to a doc or a section that does not resolve."""

    def setUp(self):
        super().setUp()
        self.r.write('docs/a.md', DOC)

    def cm4(self, body, **cfg):
        self.r.config(**cfg)
        self.r.write('CLAUDE.md', CLEAN + body)
        return self.r.run()

    def assertClean(self, body, **cfg):
        rc, out = self.cm4(body, **cfg)
        self.assertEqual(rc, 0, out)
        self.assertNotIn('CM4', out)
        return out

    def assertCM4(self, body, line=4, **cfg):
        rc, out = self.cm4(body, **cfg)
        self.assertEqual(rc, 1, out)
        self.assertIn('CM4 CLAUDE.md:%d:' % line, out)
        return out

    def test_link_to_existing_file_is_clean(self):
        out = self.assertClean('See [a](docs/a.md) and [dir](docs/).\n')
        self.assertIn('2 pointers checked', out)

    def test_link_to_missing_file(self):
        self.assertCM4('See [gone](docs/gone.md).\n')

    def test_urls_ignored(self):
        out = self.assertClean('[x](https://example.com/a.md) [m](mailto:a@b.c)\n')
        self.assertIn('0 pointers checked', out)

    def test_link_anchor_resolves_by_github_slug(self):
        self.assertClean('[s](docs/a.md#2-stack) [b](docs/a.md#breaking-changes) '
                         '[c](docs/a.md#api-contract--ci-enforcement)\n')

    def test_link_anchor_missing(self):
        self.assertCM4('[s](docs/a.md#deploy)\n')

    def test_same_file_anchor(self):
        self.assertClean('## Local\n\n[l](#local)\n')
        rc, out = self.cm4('[l](#nowhere)\n')
        self.assertIn('CM4 CLAUDE.md:4:', out)

    def test_path_section_number(self):
        self.assertClean('Read `docs/a.md` §2 first.\n')
        self.assertCM4('Read `docs/a.md` §3 first.\n')

    def test_section_number_is_not_a_prefix_of_a_longer_number(self):
        self.assertCM4('Read `docs/a.md` §1.\n')  # "## 21 Other" must not match §1 or §2.1

    def test_path_section_words(self):
        self.assertClean('Root docs/a.md § Breaking changes, root half.\n')
        self.assertCM4('Root docs/a.md § Breaking stuff, root half.\n')

    def test_section_matches_a_wrapped_heading_prefix(self):
        self.assertClean('Root `docs/a.md` §API contract\n')

    def test_quoted_section(self):
        self.assertClean('`docs/a.md` § "Service `Release gate`".\n')

    def test_pointer_running_on_into_prose(self):
        self.r.write('TODO.md', '# TODO\n\n## Post-release obligations (opened 2026-08-30)\n')
        self.assertClean('`TODO.md` § Post-release obligations is authoritative.\n')
        self.assertCM4('`TODO.md` § Post-launch obligations is authoritative.\n')

    def test_sibling_heading_does_not_cover_a_deleted_one(self):
        self.r.write('docs/b.md', '## API contract — runtime version signal\n')
        self.assertCM4('`docs/b.md` §API contract — CI enforcement.\n')

    def test_placeholder_section_is_not_a_pointer(self):
        self.assertClean('Cited as "detail §<heading>".\n', pointer_aliases={'detail': 'docs/a.md'})

    def test_section_words_against_numbered_heading(self):
        self.assertClean('`docs/a.md` §Stack.\n')

    def test_heading_inside_code_fence_does_not_count(self):
        self.assertCM4('`docs/a.md` §Not a heading.\n')

    def test_section_in_missing_file(self):
        self.assertCM4('`docs/gone.md` §2.\n')

    def test_alias(self):
        aliases = {'pointer_aliases': {'detail': 'docs/a.md'}}
        self.assertClean('Detail §Stack. Also detail §Breaking changes.\n', **aliases)
        self.assertCM4('Long form: detail §Gone.\n', **aliases)

    def test_alias_resolves_beside_each_claude_md(self):
        self.r.config(pointer_aliases={'detail': 'docs/a.md'})
        self.r.write('CLAUDE.md', CLEAN)
        self.r.write('svc/CLAUDE.md', 'Detail §Stack.\n')
        rc, out = self.r.run()
        self.assertIn('CM4 svc/CLAUDE.md:1:', out)  # svc/docs/a.md does not exist
        self.r.write('svc/docs/a.md', DOC)
        rc, out = self.r.run()
        self.assertEqual(rc, 0, out)

    def test_word_without_alias_is_not_a_pointer(self):
        self.assertClean('Detail §Gone.\n')

    def test_pointer_in_code_fence_ignored(self):
        self.assertClean('```\n[gone](docs/gone.md)\n```\n')

    def test_target_outside_root_skipped(self):
        out = self.assertClean('Up: [u](../../elsewhere/x.md), home ~/.claude/x.md §2.\n')
        self.assertIn('1 unresolvable here', out)

    def test_gitignored_absent_target_skipped(self):
        env = {k: v for k, v in os.environ.items() if not k.startswith('GIT_')}
        subprocess.run(['git', '-C', self.r.root, 'init', '-q'], env=env, check=True)
        self.r.write('.gitignore', 'svc/\n')
        out = self.assertClean('Clone: [s](svc/docs/x.md), `svc/README.md` §2.\n')
        self.assertIn('2 unresolvable here', out)

    def test_cm4_waiver(self):
        self.assertClean('`docs/gone.md` §2 lives in the umbrella.\n',
                         waivers=[{'check': 'CM4', 'path': 'CLAUDE.md', 'match': 'docs/gone.md',
                                   'reason': 'umbrella doc, absent in this repo'}])

    def test_bad_aliases_are_exit_2(self):
        for bad in ([], {'detail': ''}, {'': 'x.md'}, {'detail': 3}):
            self.r.config(pointer_aliases=bad)
            self.r.write('CLAUDE.md', CLEAN)
            self.assertEqual(self.r.run()[0], 2, bad)


class TestSelfTest(Base):
    def stamped_copy(self, body_edit=None):
        src = os.path.abspath(cmh.__file__)
        with open(src, encoding='utf-8') as f:
            lines = f.read().split('\n')
        h = hashlib.sha256('\n'.join(lines).encode('utf-8')).hexdigest()[:12]
        out = lines[:1] + [cmh.STAMP_PREFIX + ' ' + h + ' — edit canonical, not this copy'] + lines[1:]
        if body_edit:
            out.append(body_edit)
        p = self.r.write('scripts/claude_md_hygiene.py', '\n'.join(out))
        return p

    def test_stamped_copy_passes(self):
        p = self.stamped_copy()
        with contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(cmh.self_test(p), 0)

    def test_edited_copy_fails(self):
        p = self.stamped_copy('# local tweak')
        with contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(cmh.self_test(p), 1)

    def test_unstamped_copy_outside_canonical_fails(self):
        p = self.r.write('scripts/claude_md_hygiene.py', '#!/usr/bin/env python3\nprint(1)\n')
        with contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(cmh.self_test(p), 1)


if __name__ == '__main__':
    unittest.main()
