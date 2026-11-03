// konjir work guard (W6.4; JOB4): the PreToolUse hook a job's Claude Code runs before each shell
// command. A push that deletes a remote branch is denied in every form a push can take (a `:branch`
// refspec, `+:branch`, `:refs/heads/x`, one delete among several refspecs, --delete and -d however
// abbreviated or clustered, --prune, --mirror, --all), as are forced pushes, pushes to the default
// branch, merging, gh api and terraform, however the command is quoted or wrapped; a feature
// branch's ordinary push is allowed. The built konjir, run as the hook, exits 2 with why.
import { expect, test } from '@jest/globals';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { guardHook, lineDenial, simpleCommands } from '../src/cli.js';

const root = resolve(import.meta.dirname, '../../..');
/** Checked as in a worktree on `on` (undefined: HEAD detached, as a job's starts), with main the default branch. */
const deny = (line: string, on?: string) => lineDenial(line, { branch: 'main', current: () => on });

test('a push that deletes a remote branch is denied in every form a push can take (W6.4)', () => {
  for (const line of [
    'git push origin :feature', 'git push origin +:feature', 'git push origin :refs/heads/x', 'git push origin feature :old',
    'git push origin feature:feature :old another', 'git push -u origin :x', 'git push --repo=origin :x', 'git push origin -- :x',
    'git push origin --delete x', 'git push origin --del x', 'git push --delete origin x', 'git push -d origin x', 'git push origin -d x',
    'git push -ud origin x', 'git push -qd origin x', 'git push origin x --delete',
    'git push --prune origin "refs/heads/*:refs/heads/*"', 'git push --prun origin', 'git push --mirror origin', 'git push --mir origin', 'git push --all origin', 'git push --branches origin',
    'git push https://github.com/acme/orders :x', 'git push git@github.com:acme/orders.git :x',
  ]) expect([line, deny(line)]).toEqual([line, expect.stringMatching(/delete|every branch|pattern/)]);
});

test('quoting, escapes, wrappers, nesting and chaining don\'t hide a delete (W6.4)', () => {
  for (const line of [
    "git push origin ':x'", 'git push origin ":x"', 'git push origin \\:x', "git push origin $':x'", "git 'push' origin :x", '"git" push origin :x',
    '/usr/bin/git push origin :x', 'env GIT_TRACE=1 git push origin :x', 'GIT_TRACE=1 git push origin :x', 'command git push origin :x',
    'timeout 30 git push origin :x', 'nohup git push origin :x', 'xargs -n1 git push origin :x', 'npx --yes git push origin :x',
    'git --no-pager push origin :x', 'git -p push origin :x', 'git --bare push origin :x',
    'bash -c "git push origin :x"', "sh -c 'git push origin :x'", 'bash -lc "cd . && git push origin :x"', 'eval "git push origin :x"',
    'echo hi && git push origin :x', 'true; git push origin :x', 'false || git push origin :x', 'ls | git push origin :x', 'ls & git push origin :x',
    'echo $(git push origin :x)', 'echo `git push origin :x`', 'echo "$(git push origin :x)"', '(git push origin :x)', '{ git push origin :x; }',
    'if true; then git push origin :x; fi', 'git push origin :x 2>/dev/null', 'git push origin :x >out.txt 2>&1',
    'git push origin feature\ngit push origin :x', 'git push origin \\\n  :x',
  ]) expect([line, deny(line)]).toEqual([line, expect.stringMatching(/./)]);
});

test('forced pushes, pushes to the default branch, refspecs not written out, send-pack, git redirected, merging, gh api and terraform are denied (W6.4)', () => {
  const cases: [string, RegExp, string?][] = [
    ['git push --force origin x', /forces/], ['git push origin x --forc', /forces/], ['git push --force-with-lease origin x', /forces/],
    ['git push --force-with-lease=x:abc origin x', /forces/], ['git push -f origin x', /forces/], ['git push -uf origin x', /forces/], ['git push origin +x', /forces/],
    ['git push origin main', /default branch/], ['git push origin x:main', /default branch/], ['git push origin HEAD:refs/heads/main', /default branch/],
    ['git push origin HEAD', /default branch/, 'main'], ['git push origin @', /default branch/, 'main'], ['git push', /default branch/, 'main'], ['git push -u origin', /default branch/, 'main'],
    ['git push origin "refs/heads/*:refs/heads/*"', /pattern/], ['git push origin $BRANCH', /written out/], ['git push origin "$B"', /written out/],
    ['git push $FLAGS origin x', /written out/], ['git push origin $(echo x)', /written out/], ['git $X push origin :x', /written out/],
    ['git send-pack origin :x', /send-pack/], ['git http-push x :y', /http-push/],
    ['git -c core.hooksPath=/x push origin x', /-c/], ["git '-c' x=y commit", /-c/], ['git -C /elsewhere push origin x', /-C/],
    ['git --git-dir=/x push origin x', /--git-dir/], ['GIT_DIR=/x git push origin x', /GIT_DIR/], ['env GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=x GIT_CONFIG_VALUE_0=y git push', /GIT_CONFIG_COUNT/],
    ['git push origin :', /every matching branch/],['git --work-tree /x status', /--work-tree/], ['git config alias.p "push origin :x"', /config/],
    ['gh pr merge 3', /merges/], ['gh pr merge --admin 3', /merges/], ["gh 'api' repos/x", /gh api/], ['gh -R acme/x api repos', /gh api/],
    ['terraform apply', /terraform/], ['cd deploy && /usr/local/bin/terraform apply -auto-approve', /terraform/],
  ];
  for (const [line, why, on] of cases) expect([line, deny(line, on)]).toEqual([line, expect.stringMatching(why)]);
});

test('a feature branch\'s ordinary push, and everything else a job runs, is allowed (W6.4)', () => {
  for (const [line, on] of [
    ['git push origin feature'], ['git push -u origin feature'], ['git push -u origin HEAD:feature'], ['git push origin HEAD:refs/heads/w6.4-runner-gaps'],
    ['git push origin feature', 'main'], ['git push', 'feature'], ['git push -u origin', 'feature'], ['git push origin HEAD', 'feature'], ['git push origin @', 'feature'],
    ['git push --tags origin'], ['git push --follow-tags origin feature'], ['git push --no-force origin feature'], ['git push -o ci.skip origin feature'], ['git push --push-option=x origin feature'],
    ['git push --dry-run origin feature'], ['git push -n origin feature'], ['git push --no-verify -u origin feature'], ['git push origin tag v1.2'], ['git push origin feature 2>&1 | tail -3'],
    ['git commit -m "never git push origin :main"'], ['git commit -m "$(cat msg.txt)"'], ['git log --oneline -3'], ['git status'], ['git -P log'], ['git --no-pager diff'],
    ['npm test'], ['npm run build && npm test'], ['npx jest --maxWorkers=2'], ['gh pr create --title "Merge-free" --body "x"'], ['gh pr view 3'],
    ['echo "git push origin :x"'], ["grep -rn 'git push' docs"], ['ls # git push origin :x'], ['konjir work deliver kj:b#W1 --submit'],
  ] as [string, string?][]) expect([line, deny(line, on)]).toEqual([line, undefined]);
});

test('the shell split: quotes, escapes, ANSI-C strings, redirections and substitutions (W6.4)', () => {
  const words = (line: string) => simpleCommands(line).map((c) => c.map((w) => w.text));
  expect(words(`git push 'a b' "c\\"d" e\\ f $'g\\x3ah' 2>/dev/null; ls`)).toEqual([['git', 'push', 'a b', 'c"d', 'e f', 'g:h'], ['ls']]);
  expect(words('echo "$(git push origin :x)" && ls')).toEqual([['git', 'push', 'origin', ':x'], ['echo', '$(git push origin :x)'], ['ls']]);
  expect(simpleCommands('git push origin $x')[0][3]).toEqual({ text: '$x', dynamic: true });
  expect(simpleCommands("git push origin '$x'")[0][3]).toEqual({ text: '$x', dynamic: false });
});

test('heredocs: a body is data up to its delimiter, so an apostrophe in it hides nothing after it, and a line in it is no command; an unquoted one\'s substitutions run (W6.4 review)', () => {
  // Claude Code's own commit pattern, then a denied push: denied.
  const commit = (body: string) => `git commit -m "$(cat <<'EOF'\n${body}\nEOF\n)"`;
  for (const after of ['git push origin :x', 'git push --force origin x', 'git push origin x:main']) {
    const line = `${commit('it isn\'t done')} && ${after}`;
    expect([line, deny(line)]).toEqual([line, expect.stringMatching(/./)]);
  }
  for (const line of [
    'cat <<EOF\nit\'s\nEOF\ngit push origin :x', 'cat <<"EOF"\nit\'s "\nEOF\ngit push origin :x', 'cat <<-EOF\n\tit\'s\n\tEOF\ngit push origin :x',
    'cat <<\\EOF\nit\'s\nEOF\ngit push origin :x', 'cat <<EOF | git push origin :x\nbody\nEOF', 'cat <<EOF\n$(git push origin :x)\nEOF', 'cat <<EOF\n`git push origin :x`\nEOF',
  ]) expect([line, deny(line)]).toEqual([line, expect.stringMatching(/./)]);
  // A body's lines, a quoted one's substitutions among them, are data: allowed.
  for (const line of [
    commit('terraform apply\ngit push --force origin main\ngh pr merge 3\nit isn\'t done'),
    'cat > notes.md <<\'EOF\'\nterraform apply\ngit push origin :main\n$(git push origin :x)\nEOF',
    'gh pr create --title "W6.4" --body "$(cat <<\'EOF\'\n## Summary\ngh pr merge is a person\'s\nEOF\n)"',
    'cat <<-EOF > x.txt\n\tgit push --force\n\tEOF\nls',
    'git commit -F - <<EOF\nWe can\'t merge here.\nEOF',
  ]) expect([line, deny(line)]).toEqual([line, undefined]);
});

test('quoting not closed, nesting too deep and lines too long are denied, quickly (W6.4 review)', () => {
  for (const line of ['git push origin \':x', 'echo "it is', 'echo $(git push origin feature', 'echo `ls', "echo $'x", 'cat <<\'EOF']) {
    expect([line, deny(line)]).toEqual([line, expect.stringMatching(/can't read this command/)]);
  }
  const deep = `${'$('.repeat(5000)}ls${')'.repeat(5000)}`;
  const t0 = Date.now();
  expect(deny(deep)).toMatch(/nest deeper/);
  expect(guardHook(JSON.stringify({ tool_name: 'Bash', tool_input: { command: deep } }), 'main').code).toBe(2);
  expect(deny('x'.repeat(300_000))).toMatch(/more than the guard reads/);
  expect(Date.now() - t0).toBeLessThan(500);
});

test('git\'s short names for the default branch, and pushes whose branch can\'t be known before they run, are denied (W6.4 review)', () => {
  for (const [line, why, on] of [
    ['git push origin x:heads/main', /default branch/], ['git push origin heads/main', /default branch/], ['git push origin HEAD:heads/main', /default branch/],
    ['git checkout main && git push origin HEAD', /can't be known/, 'feature'], ['git switch main; git push', /can't be known/, 'feature'],
    ['cd ../other && git push -u origin', /can't be known/, 'feature'], ['echo :x | xargs git push origin', /xargs/], ['xargs -n1 git push origin < refs.txt', /xargs/],
    ['bash -c -- "git push origin :x"', /deletes/], ['env -S "git push origin :x"', /deletes/], ['env -S"git push" origin :x', /deletes/], ['env --split-string="git push origin :x"', /deletes/],
  ] as [string, RegExp, string?][]) expect([line, deny(line, on)]).toEqual([line, expect.stringMatching(why)]);
  for (const [line, on] of [
    ['git push origin x:refs/remotes/origin/main'], ['git push origin x:main-2'], ['git push origin heads/feature'], ['git checkout -b feature && git push -u origin feature', 'main'],
    ['cd sub && npm test'], ['env git commit -S -m x'],
  ] as [string, string?][]) expect([line, deny(line, on)]).toEqual([line, undefined]);
});

test('after git checkout -b or git switch -c with its name written out, and only &&, a push of HEAD, @ or no refspec pushes that new branch (W6.4 re-review)', () => {
  // Judged as pushes of the new branch, whatever was checked out before: a feature branch's allowed.
  for (const line of [
    'git checkout -b feat && git push -u origin HEAD', 'git checkout -B feat && git push origin @', 'git switch -c feat && git push -u origin',
    'git switch -C feat origin/main && git add -A && git commit -m x && git push -u origin HEAD', 'git switch --create feat && git push origin HEAD',
    'git checkout -b feat --track origin/x && git push', 'git checkout main && git checkout -b feat && git push -u origin HEAD',
  ]) expect([line, deny(line, 'main')]).toEqual([line, undefined]);
  // The default branch's name, or a branch the guard can't know: denied.
  for (const [line, why] of [
    ['git checkout -b main && git push origin HEAD', /default branch/], ['git switch -c main && git push -u origin', /default branch/],
    ['git checkout -b feat || git push origin HEAD', /can't be known/], ['git checkout -b feat; git push origin HEAD', /can't be known/],
    ['git checkout -b feat\ngit push origin HEAD', /can't be known/], ['git checkout -b feat | cat && git push origin HEAD', /can't be known/],
    ['git checkout -b "$B" && git push origin HEAD', /can't be known/], ['git checkout -b feat && cd .. && git push origin HEAD', /can't be known/],
    ['git checkout -b feat && git checkout main && git push origin HEAD', /can't be known/], ['git checkout -b feat && git symbolic-ref HEAD refs/heads/main && git push', /can't be known/],
    ['git switch feat && git push origin HEAD', /can't be known/], ['git checkout -b feat && (git push origin HEAD)', /can't be known/],
  ] as [string, RegExp][]) expect([line, deny(line, 'feature')]).toEqual([line, expect.stringMatching(why)]);
});

test('the hook: Claude Code\'s PreToolUse input in, exit 2 and why for a denial, 0 otherwise; input it can\'t read is denied (W6.4)', () => {
  const input = (command: unknown, cwd = '/') => JSON.stringify({ session_id: 's', hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, cwd });
  expect(guardHook(input('git push origin :x'), 'main')).toEqual({ code: 2, message: expect.stringMatching(/^Denied in a Konjir job: the refspec :x deletes x on the remote\. /) });
  expect(guardHook(input('git push origin feature'), 'main')).toEqual({ code: 0 });
  expect(guardHook('not json', 'main')).toEqual({ code: 2, message: expect.stringMatching(/couldn't read/) });
  expect(guardHook(input(42), 'main')).toEqual({ code: 2, message: expect.stringMatching(/no command/) });
  expect(guardHook(JSON.stringify({ tool_name: 'Read', tool_input: { file_path: '/x' } }), 'main')).toEqual({ code: 0 });
  // Monitor runs a shell command too, and is checked alike.
  expect(guardHook(JSON.stringify({ tool_name: 'Monitor', tool_input: { command: 'git push origin :x', description: 'd' } }), 'main').code).toBe(2);
  expect(guardHook(JSON.stringify({ tool_name: 'Monitor', tool_input: {} }), 'main').code).toBe(2);

  // On the default branch, a bare push is denied, read from the hook's cwd; on another, allowed.
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'konjir-guard-')));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } });
  git('init', '-q', '-b', 'main');
  expect(guardHook(input('git push', dir), 'main').code).toBe(2);
  git('symbolic-ref', 'HEAD', 'refs/heads/feature');
  expect(guardHook(input('git push', dir), 'main').code).toBe(0);

  // The built konjir, as Claude Code runs it: inside a job (KONJIR_JOB set, no token), it talks to no Kolab.
  const hook = (command: string) => spawnSync('node', [join(root, 'apps/cli/dist/main.js'), 'work', 'guard', '--branch', 'main'],
    { input: input(command, dir), encoding: 'utf8', env: { PATH: process.env.PATH, HOME: process.env.HOME, KONJIR_JOB: 'J1', KONJIR_URL: 'http://127.0.0.1:9/mcp' } });
  const denied = hook("git push origin '+:old'");
  expect([denied.status, denied.stderr]).toEqual([2, expect.stringMatching(/^Denied in a Konjir job: the refspec \+:old deletes old on the remote\./)]);
  const allowed = hook('git push -u origin feature');
  expect([allowed.status, allowed.stderr]).toEqual([0, '']);
});
