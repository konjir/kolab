#!/usr/bin/env python3
"""A live check of hosting: a machine that hosts starts a real OpenCode session, asked from another
"machine" (a second config folder holding the same person's login), and a message wakes it there.

Not run in CI: it starts a real OpenCode session (yours, on your account) in a real screen or tmux
session, against a Kolab started here by scripts/e2e.mjs. Run from the repository's root:

    python3 -I apps/konnect/scripts/host-live.py <konnect: a bundle or a wrapper that runs the source>

It prints what happened at each step: hosting in the background, an unpaired machine refused,
pairing, the agent started on the hosting machine and listed there, a mention answered with nobody
typing, and the agent and the hosting stopped from the other machine.
"""
import json, os, re, shutil, subprocess, sys, tempfile, time

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "../../.."))
KONNECT = os.path.abspath(sys.argv[1])
tmp = tempfile.mkdtemp(prefix="konnect-host-live-")
hold = os.path.join(tmp, "hold.json")
e2e = subprocess.Popen(["node", os.path.join(ROOT, "apps/konnect/scripts/e2e.mjs"), "--konnect", KONNECT], env={**os.environ, "E2E_HOLD": hold}, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
end = time.time() + 180
while not os.path.exists(hold):
    if e2e.poll() is not None or time.time() > end: sys.exit("the end-to-end run ended before holding:\n" + (e2e.stdout.read() if e2e.stdout else ""))
    time.sleep(0.5)
time.sleep(0.5)
info = json.load(open(hold))
cmd, team = info["konnect"], info["team"]
base = {k: v for k, v in os.environ.items() if not k.startswith("KONNECT_")}
# The laptop: another config folder with the same person's login, and nothing else of the desk's.
laptop = os.path.join(tmp, "laptop-config")
os.makedirs(laptop, mode=0o700)
shutil.copytree(os.path.join(info["lead"]["config"], "teams"), os.path.join(laptop, "teams"))
places = {"desk": (info["lead"]["config"], info["lead"]["work"]), "laptop": (laptop, tmp), "peer": (info["peer"]["config"], info["peer"]["work"])}
def konnect(who, *args, timeout=200):
    config, work = places[who]
    r = subprocess.run([*cmd, *args], env={**base, "KONNECT_URL": info["url"], "KONNECT_CONFIG_DIR": config}, cwd=work, capture_output=True, text=True, timeout=timeout)
    return r.returncode, r.stdout.strip(), r.stderr.strip()
def sessions():
    out = subprocess.run(["tmux", "list-sessions", "-F", "#{session_name}"], capture_output=True, text=True).stdout if shutil.which("tmux") else subprocess.run(["screen", "-ls"], capture_output=True, text=True).stdout
    return sorted(set(re.findall(r"konnect[-_][A-Za-z0-9_-]+", out)))

out = []
host_session, agent_session = f"konnect_host_{team}_desk", f"konnect-{team}-helper"
try:
    code, said, err = konnect("desk", "host", "run", "--background", "desk")
    pair = re.search(r"konnect host pair desk (\S+)", said)
    out.append(f"desk hosts in the background: exit {code}; its session is there: {host_session in sessions()}; it showed a code: {bool(pair)} {err}")
    code, said, err = konnect("laptop", "host", "list")
    out.append(f"the laptop lists it: exit {code} | {said}")
    code, said, err = konnect("laptop", "agent", "run", "--on", "desk", "helper", "opencode")
    out.append(f"unpaired, the laptop is refused: exit {code} | {err[:160]}")
    code, said, err = konnect("laptop", "host", "pair", "desk", pair.group(1))
    out.append(f"the laptop pairs: exit {code} | {said} {err}")
    code, said, err = konnect("laptop", "agent", "run", "--on", "desk", "helper", "opencode")
    out.append(f"the laptop starts helper on the desk: exit {code} | {said} {err}")
    out.append(f"helper's session is on the desk: {agent_session in sessions()}; the laptop keeps no login of its own for it: {not os.path.exists(os.path.join(laptop, 'agents'))}")
    time.sleep(8)
    code, said, err = konnect("laptop", "agent", "list")
    out.append(f"the laptop's agent list: exit {code} | {said}")
    time.sleep(15)                              # OpenCode is up and idle; nobody types from here on
    code, said, err = konnect("peer", "send", "#general", "@lead/helper please reply in #general with exactly the word PINEAPPLE and nothing else")
    out.append(f"peer sent the mention: exit {code} {said} {err}")
    t0 = time.time(); ok = False
    while time.time() - t0 < 150 and not ok:
        time.sleep(5); c, hist, _ = konnect("peer", "history", "-n", "5", "#general"); ok = bool(re.search(r"@lead/helper\n\s+PINEAPPLE", hist))
    out.append(f"the agent on the desk answered in #general with nobody typing: {ok} (after {int(time.time() - t0)}s)")
    out += ["--- #general, as peer sees it", konnect("peer", "history", "-n", "3", "#general")[1], "---"]
    code, said, err = konnect("laptop", "agent", "stop", "--on", "desk", "helper")
    out.append(f"the laptop stops helper on the desk: exit {code} | {said} {err}; its session is gone: {agent_session not in sessions()}")
    code, said, err = konnect("laptop", "host", "stop", "desk")
    time.sleep(2)
    out.append(f"the laptop ends hosting on the desk: exit {code} | {said} {err}; its session is gone: {host_session not in sessions()}")
    out.append(f"and it is listed no more: {konnect('laptop', 'host', 'list')[1]}")
finally:
    for s in (agent_session, host_session):
        if shutil.which("tmux"): subprocess.run(["tmux", "kill-session", "-t", f"={s}"], capture_output=True)
        else:
            for sid in re.findall(rf"\d+\.{re.escape(s)}(?=\s)", subprocess.run(["screen", "-ls"], capture_output=True, text=True).stdout): subprocess.run(["screen", "-S", sid, "-X", "quit"], capture_output=True)
    open(hold + ".done", "w").close()
    try: e2e.wait(timeout=30)
    except Exception: e2e.kill()
    print("\n".join(out))
