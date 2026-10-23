#!/usr/bin/python3
"""Copies one unit's journal to a file the CloudWatch agent ships (P11, D68; observe.sh installs it).

    journal-copy.py <unit> <file>            follow <unit>.service's journal from now on
    journal-copy.py <unit> <file> --stdin    read `journalctl --output=json` lines from stdin (tests)

- It starts from now (journalctl --lines=0) and never replays older lines, so a restart of this
  copy can't count an old crash or dead job again; the price is the few lines a restart misses.
- The service's own lines go out as they are, masked: Kolab's tokens (kj<letter>_), GitHub's, a
  URL's password, an OAuth code or state in a query string, a bearer or basic credential, and any
  JSON field whose name says it holds a secret. Caddy's lines carry request URIs, which can hold an
  OAuth code and state, so they are masked here, before they leave the instance. A JSON line also
  gets `_SYSTEMD_UNIT`, from the journal's own trusted field, so CloudWatch's filters can tell
  Kolab's lines from Caddy's, and no line can claim to be another's.
- systemd's own lines about the unit (`_PID` 1: "Main process exited", "Stopped") go out as JSON
  with `_PID`, `UNIT` and `MESSAGE_ID` from the journal, so the service-exited filter matches only
  them. A service's JSON line that carries any of those fields has them removed.
- Every 5 minutes it writes a heartbeat line, so the log group hears from each copy even when Kolab
  is idle; the no-logs alarm fires when neither copy nor the agent is shipping.

The masking follows libs/log (maskSecrets); keep the two alike.
"""
import json
import os
import re
import selectors
import subprocess
import sys
import time

HEARTBEAT_S = 300

TOKENS = re.compile(r'(kj[a-z])_[A-Za-z0-9_-]+')
GITHUB_TOKENS = re.compile(r'\b(gh[opusr]|github_pat)_[A-Za-z0-9_]+')
URL_PASSWORD = re.compile(r'\b([a-z][a-z0-9+.-]*://[^:/@\s]*):[^@/\s]*@', re.I)
QUERY_SECRET = re.compile(r'([?&](?:code|state)=)[^&#"\'\s]+')
AUTH_SCHEME = re.compile(r'\b(Bearer|Basic) +([A-Za-z0-9_.~+/-]+=*)')
SECRET_FIELD = re.compile(r'token|secret|passw(or)?d|authorization|cookie|credential|api[-_]?key|private[-_]?key|code_verifier|^code$|^state$', re.I)
CREDENTIAL_CHARS = re.compile(r'[0-9_.~+/=-]')
# Fields only this copy writes, from the journal's trusted fields.
TRUSTED = ('_SYSTEMD_UNIT', '_PID', 'UNIT', 'MESSAGE_ID')


def credential_like(word):
    return len(word) >= 24 or (len(word) >= 12 and CREDENTIAL_CHARS.search(word) is not None)


def mask_text(text):
    text = AUTH_SCHEME.sub(lambda m: m.group(1) + ' ***' if credential_like(m.group(2)) else m.group(0), text)
    text = URL_PASSWORD.sub(r'\1:***@', text)
    text = QUERY_SECRET.sub(r'\1***', text)
    text = TOKENS.sub(r'\1_***', text)
    return GITHUB_TOKENS.sub(r'\1_***', text)


def mask_value(v):
    if isinstance(v, str):
        return mask_text(v)
    if isinstance(v, list):
        return [mask_value(x) for x in v]
    if isinstance(v, dict):
        return {k: ('***' if SECRET_FIELD.search(k) else mask_value(x)) for k, x in v.items()}
    return v


def message_of(entry):
    m = entry.get('MESSAGE')
    if isinstance(m, list):  # journalctl writes a message that isn't UTF-8 as its bytes
        return bytes(x for x in m if isinstance(x, int) and 0 <= x < 256).decode('utf-8', 'replace')
    return '' if m is None else str(m)


def iso(entry):
    try:
        t = int(entry['__REALTIME_TIMESTAMP']) / 1e6
    except (KeyError, TypeError, ValueError):
        t = time.time()
    return time.strftime('%Y-%m-%dT%H:%M:%S', time.gmtime(t)) + '.%03dZ' % (int(t * 1000) % 1000)


def line_of(entry, unit):
    """The line to ship for one journal entry, or None."""
    message = message_of(entry).rstrip('\n')
    if entry.get('_PID') == '1':
        out = {'time': iso(entry), 'level': 'notice', 'message': mask_text(message), '_PID': '1', 'UNIT': entry.get('UNIT') or unit}
        if entry.get('MESSAGE_ID'):
            out['MESSAGE_ID'] = entry['MESSAGE_ID']
        return json.dumps(out, ensure_ascii=False, separators=(',', ':'))
    if message.startswith('{'):
        try:
            parsed = json.loads(message)
        except ValueError:
            parsed = None
        if isinstance(parsed, dict):
            out = mask_value({k: v for k, v in parsed.items() if k not in TRUSTED})
            if entry.get('_SYSTEMD_UNIT'):
                out['_SYSTEMD_UNIT'] = entry['_SYSTEMD_UNIT']
            return json.dumps(out, ensure_ascii=False, separators=(',', ':'))
    return mask_text(message) if message else None


def heartbeat(unit):
    return json.dumps({
        'time': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()), 'level': 'info',
        'message': f'konjir-journal@{unit}: copying {unit}.service\'s journal', 'event': 'heartbeat', 'unit': f'{unit}.service',
    }, separators=(',', ':'))


def main(argv):
    if len(argv) < 3 or not re.fullmatch(r'[a-z][a-z0-9-]*', argv[1]):
        sys.exit('usage: journal-copy.py <unit> <file> [--stdin]')
    unit, path = argv[1], argv[2]
    if '--stdin' in argv[3:]:
        proc, src = None, sys.stdin.buffer
    else:
        proc = subprocess.Popen([os.environ.get('JOURNALCTL', '/usr/bin/journalctl'), '--follow', '--lines=0', '--no-pager', '--output=json', f'--unit={unit}.service'],
                                stdout=subprocess.PIPE)
        src = proc.stdout
    fd = src.fileno()
    # A pipe from journalctl waits for lines or the next heartbeat; a test's stdin is just read.
    sel = None
    if proc is not None:
        sel = selectors.DefaultSelector()
        sel.register(fd, selectors.EVENT_READ)
    pending = b''
    next_beat = time.monotonic()
    # Appending (O_APPEND) keeps writing at the end after logrotate's copytruncate empties the file.
    with open(path, 'a', encoding='utf-8') as out:
        while True:
            if sel is not None:
                now = time.monotonic()
                if now >= next_beat:
                    out.write(heartbeat(unit) + '\n')
                    out.flush()
                    next_beat = now + HEARTBEAT_S
                if not sel.select(timeout=max(0.0, next_beat - time.monotonic())):
                    continue
            chunk = os.read(fd, 65536)
            if not chunk:
                break
            pending += chunk
            *lines, pending = pending.split(b'\n')
            for raw in lines:
                if not raw.strip():
                    continue
                try:
                    entry = json.loads(raw)
                except ValueError:
                    continue
                shipped = line_of(entry, unit)
                if shipped:
                    out.write(shipped + '\n')
            out.flush()
    # journalctl ended: exit non-zero, and systemd starts the copy again (Restart=always).
    if proc is not None:
        sys.exit(f'journalctl exited with {proc.wait()}')


if __name__ == '__main__':
    main(sys.argv)
