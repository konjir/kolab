#!/usr/bin/env python3
"""A live check that a message wakes an idle Claude Code, OpenCode or Codex session started by `konnect agent run`.

Not run in CI: it starts a real Claude Code session (yours, on your account) in a terminal it plays,
against a Kolab started here by scripts/e2e.mjs. Run from the repository's root:

    python3 apps/konnect/scripts/wake-live.py <konnect: a bundle or a wrapper that runs the source> [claude|opencode|codex]

Run it from a terminal of your own for Codex: Codex must be signed in (codex login) where this runs.

It prints what happened: whether the session woke with nobody typing, received the message with
konnect_receive, and answered in the channel.
"""
import fcntl, json, os, pty, re, select, signal, struct, subprocess, sys, tempfile, termios, time

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "../../.."))
KONNECT = os.path.abspath(sys.argv[1])
HARNESS = sys.argv[2] if len(sys.argv) > 2 else "claude"
tmp = tempfile.mkdtemp(prefix="konnect-live-")
hold = os.path.join(tmp, "hold.json")
e2e = subprocess.Popen(["node", os.path.join(ROOT, "apps/konnect/scripts/e2e.mjs"), "--konnect", KONNECT], env={**os.environ, "E2E_HOLD": hold}, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
end = time.time() + 180
while not os.path.exists(hold):
    if e2e.poll() is not None or time.time() > end: sys.exit("the end-to-end run ended before holding:\n" + (e2e.stdout.read() if e2e.stdout else ""))
    time.sleep(0.5)
time.sleep(0.5)
info = json.load(open(hold))
cmd = info["konnect"]
base = {k: v for k, v in os.environ.items() if not k.startswith("KONNECT_")}
def person(who): return {**base, "KONNECT_URL": info["url"], "KONNECT_CONFIG_DIR": info[who]["config"]}
def konnect(who, *args):
    r = subprocess.run([*cmd, *args], env=person(who), cwd=info[who]["work"], capture_output=True, text=True, timeout=90)
    return r.returncode, r.stdout.strip(), r.stderr.strip()

pid, fd = pty.fork()
if pid == 0:
    os.chdir(info["lead"]["work"])
    os.execvpe(cmd[0], [*cmd, "agent", "run", "helper", HARNESS, *(["--model", "claude-haiku-5-5"] if HARNESS == "claude" else [])], person("lead"))
# The terminal this script plays: of a size, and answering what a harness asks of it as it starts (Codex draws nothing in one that doesn't).
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 120, 0, 0))
buf = b""
def pump(seconds, until=None):
    global buf
    stop = time.time() + seconds
    while time.time() < stop:
        r, _, _ = select.select([fd], [], [], 0.5)
        if r:
            try: got = os.read(fd, 65536)
            except OSError: return
            buf += got
            if b"\x1b[6n" in got: os.write(fd, b"\x1b[1;1R")
            if b"\x1b[c" in got: os.write(fd, b"\x1b[?62;c")
            if b"\x1b[?u" in got: os.write(fd, b"\x1b[?0u")
        if until and until(): return
def screen():
    s = buf.decode("utf8", "replace")
    s = re.sub(r"\x1b\[[0-9;?]*[a-zA-Z]", "", s); s = re.sub(r"\x1b[\]()][^\x07\x1b]*(\x07|\x1b\\)?", "", s)
    return re.sub(r"[\r\n]+\s*", "\n", s)

out = []
try:
    pump(10)
    seen = re.sub(r"\s+", "", screen()).lower()
    if HARNESS == "codex" and "signinwithchatgpt" in seen:
        sys.exit("Codex is asking to sign in here: run codex login in this terminal first, then this check again.")
    if HARNESS == "codex" and "trustthisfolder" in seen:      # Codex's own question, for a folder this script made: Trust is the one it offers first
        os.write(fd, b"\r"); pump(5)
    elif "trust" in seen:                      # Claude Code's folder-trust question: No is offered first
        os.write(fd, b"\x1b[B"); pump(1); os.write(fd, b"\r")
    pump(25)                                   # the session is idle at its prompt; nobody types from here on
    started = screen()
    out.append("the session started: " + str(len(started) > 200))
    def state():
        c, listed, _ = konnect("peer", "team", "list")
        return next((l.split()[-1] if l.split()[-2:] != ["not", "running"] else "not running" for l in listed.splitlines() if l.startswith("@lead/helper")), "?")
    out.append("idle at its prompt, the team list says the agent is: " + state())
    code, said, err = konnect("peer", "send", "#general", "@lead/helper please reply in #general with exactly the word PINEAPPLE and nothing else")
    out.append(f"peer sent the mention: exit {code} {said} {err}")
    states = set()
    def answered():
        states.add(state())
        c, hist, _ = konnect("peer", "history", "-n", "5", "#general")
        return bool(re.search(r"@lead/helper\n\s+PINEAPPLE", hist))
    t0 = time.time(); ok = False
    while time.time() - t0 < 90 and not ok:
        pump(5); ok = answered()
    after = screen()[len(started):]
    out.append(f"the agent answered in #general with nobody typing: {ok} (after {int(time.time() - t0)}s)")
    pump(8)
    out.append(f"while it answered, the team list said: {sorted(states)}; and once it was waiting again: {state()}")
    out.append("the session called konnect_receive: " + str("konnect_receive" in after or "receive" in after.lower()))
    c, hist, _ = konnect("peer", "history", "-n", "4", "#general")
    out += ["--- #general, as peer sees it", hist, "--- the session's screen after the mention (tail)", after[-900:]]
    # A second message, after the session went idle again: the hook must be waiting again.
    code, said, err = konnect("peer", "send", "@lead/helper", "please reply to me directly with exactly the word MANGO and nothing else")
    t0 = time.time(); ok2 = False
    while time.time() - t0 < 90 and not ok2:
        pump(5); c, hist2, _ = konnect("peer", "history", "-n", "3", "@lead/helper"); ok2 = bool(re.search(r"@lead/helper\n\s+MANGO", hist2))
    out.append(f"a second message, a direct one, woke it again and was answered: {ok2} (after {int(time.time() - t0)}s)")
finally:
    try: os.write(fd, b"/exit\r"); pump(3)
    except OSError: pass
    try: os.kill(pid, signal.SIGTERM)
    except OSError: pass
    time.sleep(3)
    try: out.append("after its harness ended, the team list says the agent is: " + state())
    except Exception as e: out.append(f"(the team list couldn't be read at the end: {e})")
    open(hold + ".done", "w").close()
    try: e2e.wait(timeout=30)
    except Exception: e2e.kill()
    print("\n".join(out))
