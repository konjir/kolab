#!/usr/bin/python3
"""Copies one unit's journal to a file the CloudWatch agent ships (P11, D68; observe.sh installs it).

    journal-copy.py <unit> <file>            follow <unit>.service's journal from now on
    journal-copy.py <unit> <file> --stdin    read `journalctl --output=json` lines from stdin (tests)

- It starts from now (journalctl --lines=0) and never replays older lines, so a restart of this
  copy can't count an old crash or dead job again; the price is the few lines a restart misses.
  It reads with --all, or journalctl would write any line over 4 KB as null, and it would be lost.
- The service's own lines go out masked: Kolab's tokens (kj<letter>_), GitHub's, a URL's or libpq's
  password, a secret in a query string, a bearer or basic credential, and any JSON field whose name
  says it holds a secret. Caddy's lines carry request URIs, which can hold an OAuth code and state,
  so they are masked here, before they leave the instance. A JSON line also gets `_SYSTEMD_UNIT`,
  from the journal's own trusted field, so CloudWatch's filters can tell Kolab's lines from
  Caddy's; a line that isn't JSON has any such field name in it struck out.
- systemd's own lines about the unit (`_PID` 1: "Main process exited", "Stopped") go out as JSON
  with `_PID`, `UNIT` and `MESSAGE_ID` from the journal, so the service-exited filter matches only
  them. A service's line that carries any of those fields has them removed.
- A line is at most 16 KiB: a longer one has its longest strings cut, and says `"truncated":true`.
- Every 5 minutes it writes a probe into the unit's journal (logger --journald) and a heartbeat
  line to the file, with the time of the last journal line it read and how long ago that was. The
  probe comes back through journalctl within moments, so a heartbeat with a journal_age_s over 15
  minutes means journalctl is stuck; the no-logs alarm counts only fresh heartbeats, and the copy
  exits after 20 minutes so that systemd starts it again.

The masking follows libs/log (maskSecrets), and libs/log/test/mask-vectors.json holds both to it.
"""
import base64
import json
import os
import re
import selectors
import subprocess
import sys
import time

HEARTBEAT_S = 300
STALE_EXIT_S = 1200
MAX_LINE = 16384
TRUNCATED = '…[truncated]'
PROBE_FIELD = 'KONJIR_JOURNAL_PROBE'

A = re.ASCII
TOKENS = re.compile(r'(kj[a-z])_[A-Za-z0-9_-]+', A)
GITHUB_TOKENS = re.compile(r'\b(gh[opusr]|github_pat)_[A-Za-z0-9_]+', A)
URL_PASSWORD = re.compile(r'\b([a-z][a-z0-9+.-]*://[^:/@\s"\'<>]*):[^\s"\'<>]*@', A | re.I)
KEYWORD_PASSWORD = re.compile(r'\b(password|passwd|pwd)=(\'[^\']*\'|[^\s&;"\']+)', A | re.I)
QUERY_SECRET = re.compile(r'([?&](?:code|state|client_secret|access_token|refresh_token|code_verifier|token|password)=)[^&#"\'\s]+', A | re.I)
AUTH_SCHEME = re.compile(r'\b(bearer|basic)([ \t:]+)([A-Za-z0-9_.~+/-]+=*)', A | re.I)
SECRET_FIELD = re.compile(r'token|secret|passw(or)?d|^pass$|^pwd$|authorization|cookie|credential|api[-_]?key|private[-_]?key|code[-_]?verifier|session[-_]?id|^code$|^state$', A | re.I)
CREDENTIAL_CHARS = re.compile(r'[0-9_.~+/=-]', A)
BASE64 = re.compile(r'[A-Za-z0-9+/]+={0,2}', A)
# Fields only this copy writes, from the journal's trusted fields; and the same names in a line that isn't JSON.
TRUSTED = ('_SYSTEMD_UNIT', '_PID', 'UNIT', 'MESSAGE_ID')
FORGED = re.compile(r'"?\b(?:_SYSTEMD_UNIT|_PID|UNIT|MESSAGE_ID)\b"?\s*[:=]\s*(?:"[^"]*"|[^\s,}]*)\s*,?', A)


def is_basic_pair(word):
    if len(word) < 4 or len(word) % 4 or not BASE64.fullmatch(word):
        return False
    try:
        return ':' in base64.b64decode(word).decode('latin-1')
    except ValueError:
        return False


def credential_like(scheme, word):
    if len(word) >= 24 or (len(word) >= 12 and CREDENTIAL_CHARS.search(word)):
        return True
    return scheme.lower() == 'basic' and is_basic_pair(word)


def mask_text(text):
    text = AUTH_SCHEME.sub(lambda m: m.group(1) + m.group(2) + '***' if credential_like(m.group(1), m.group(3)) else m.group(0), text)
    text = URL_PASSWORD.sub(r'\1:***@', text)
    text = KEYWORD_PASSWORD.sub(r'\1=***', text)
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


def dumps(v):
    return json.dumps(v, ensure_ascii=False, separators=(',', ':'))


def size(s):
    return len(s.encode('utf-8'))


def cap_text(text):
    if size(text) <= MAX_LINE:
        return text
    return text.encode('utf-8')[:MAX_LINE - size(TRUNCATED) - 1].decode('utf-8', 'ignore') + ' ' + TRUNCATED


def strings_of(v, path=()):
    if isinstance(v, str):
        yield path, v
    elif isinstance(v, dict):
        for k, x in v.items():
            yield from strings_of(x, path + (k,))
    elif isinstance(v, list):
        for i, x in enumerate(v):
            yield from strings_of(x, path + (i,))


def put_at(v, path, value):
    for p in path[:-1]:
        v = v[p]
    v[path[-1]] = value


def cap_json(out):
    """The line for a JSON object, at most MAX_LINE bytes: its longest strings cut first."""
    line = dumps(out)
    for _ in range(64):
        if size(line) <= MAX_LINE:
            return line
        out['truncated'] = True
        path, longest = max(strings_of(out), key=lambda ps: len(ps[1]), default=((), ''))
        if not path or len(longest) <= 64:
            break
        put_at(out, path, longest[:len(longest) // 2] + TRUNCATED)
        line = dumps(out)
    if size(line) <= MAX_LINE:
        return line
    # Still too long (many fields): what the alarms need, and the message.
    kept = {k: out[k] for k in ('time', 'level', 'event', 'id', 'kolab', 'job', 'status', '_SYSTEMD_UNIT', '_PID', 'UNIT') if k in out and not isinstance(out[k], (dict, list))}
    kept['message'] = cap_text(str(out.get('message', '')))[:4096]
    kept['truncated'] = True
    return dumps(kept)


def message_of(entry):
    m = entry.get('MESSAGE')
    if isinstance(m, list):  # journalctl writes a message that isn't UTF-8 as its bytes
        return bytes(x for x in m if isinstance(x, int) and 0 <= x < 256).decode('utf-8', 'replace')
    return '' if m is None else str(m)


def iso(seconds):
    return time.strftime('%Y-%m-%dT%H:%M:%S', time.gmtime(seconds)) + '.%03dZ' % (int(seconds * 1000) % 1000)


def realtime(entry):
    try:
        return int(entry['__REALTIME_TIMESTAMP']) / 1e6
    except (KeyError, TypeError, ValueError):
        return time.time()


def text_line(message):
    return cap_text(FORGED.sub('', mask_text(message)))


def line_of(entry, unit):
    """The line to ship for one journal entry, or None."""
    message = message_of(entry).rstrip('\n')
    if entry.get('_PID') == '1':
        out = {'time': iso(realtime(entry)), 'level': 'notice', 'message': mask_text(message), '_PID': '1', 'UNIT': entry.get('UNIT') or f'{unit}.service'}
        if entry.get('MESSAGE_ID'):
            out['MESSAGE_ID'] = entry['MESSAGE_ID']
        return cap_json(out)
    if message.lstrip().startswith('{'):
        try:
            parsed = json.loads(message)
            if isinstance(parsed, dict):
                out = mask_value({k: v for k, v in parsed.items() if k not in TRUSTED})
                if entry.get('_SYSTEMD_UNIT'):
                    out['_SYSTEMD_UNIT'] = entry['_SYSTEMD_UNIT']
                return cap_json(out)
        except (ValueError, RecursionError):
            pass  # not JSON, or nested too deep to walk: shipped as masked text
    return text_line(message) if message.strip() else None


def heartbeat(unit, last_line, age_s):
    return dumps({
        'time': iso(time.time()), 'level': 'info',
        'message': f'konjir-journal@{unit}: copying {unit}.service\'s journal; its last line was {int(age_s)} s ago',
        'event': 'heartbeat', 'unit': f'{unit}.service',
        'last_journal_line': iso(last_line) if last_line else None, 'journal_age_s': int(age_s),
    })


def probe(unit):
    """A line in the unit's journal (journalctl -u matches a root process's OBJECT_SYSTEMD_UNIT), read back to show journalctl is alive."""
    fields = f'MESSAGE=konjir-journal@{unit}: probe\nSYSLOG_IDENTIFIER=konjir-journal\nOBJECT_SYSTEMD_UNIT={unit}.service\n{PROBE_FIELD}=1\n'
    try:
        subprocess.run(['/usr/bin/logger', '--journald'], input=fields.encode(), timeout=10, check=False)
    except (OSError, subprocess.SubprocessError):
        pass  # no probe: the next heartbeat is stale, which is the point


def main(argv):
    if len(argv) < 3 or not re.fullmatch(r'[a-z][a-z0-9-]*', argv[1], A):
        sys.exit('usage: journal-copy.py <unit> <file> [--stdin]')
    unit, path = argv[1], argv[2]
    following = '--stdin' not in argv[3:]
    if following:
        proc = subprocess.Popen([os.environ.get('JOURNALCTL', '/usr/bin/journalctl'), '--follow', '--lines=0', '--all', '--no-pager', '--output=json', f'--unit={unit}.service'],
                                stdout=subprocess.PIPE)
        fd = proc.stdout.fileno()
        sel = selectors.DefaultSelector()
        sel.register(fd, selectors.EVENT_READ)
    else:
        fd = sys.stdin.buffer.fileno()
    pending = b''
    started = time.monotonic()
    last_read, last_line = started, None
    next_beat = started
    # Appending (O_APPEND) keeps writing at the end after logrotate's copytruncate empties the file.
    with open(path, 'a', encoding='utf-8') as out:
        while True:
            if following:
                now = time.monotonic()
                if now >= next_beat:
                    age = now - last_read
                    out.write(heartbeat(unit, last_line, age) + '\n')
                    out.flush()
                    if age > STALE_EXIT_S:
                        proc.kill()
                        sys.exit(f'journalctl has returned nothing for {int(age)} s, probes included; starting again')
                    probe(unit)
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
                except (ValueError, RecursionError):
                    continue
                if not isinstance(entry, dict):
                    continue
                last_read, last_line = time.monotonic(), realtime(entry)
                if entry.get(PROBE_FIELD) and entry.get('_UID') == '0':
                    continue
                try:
                    shipped = line_of(entry, unit)
                except Exception:  # never let one line stop the copy
                    shipped = text_line('konjir-journal: a line could not be read, and was dropped')
                if shipped:
                    out.write(shipped + '\n')
            out.flush()
    # journalctl ended: exit non-zero, and systemd starts the copy again (Restart=always).
    if following:
        sys.exit(f'journalctl exited with {proc.wait()}')


if __name__ == '__main__':
    main(sys.argv)
