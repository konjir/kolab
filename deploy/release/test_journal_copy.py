"""Tests of journal-copy.py. libs/log's Jest run calls this (libs/log/test/journal-copy.test.ts), so
the shared masking vectors in libs/log/test/mask-vectors.json are checked against both maskings.

    python3 deploy/release/test_journal_copy.py
"""
import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import unittest

sys.dont_write_bytecode = True  # no __pycache__ beside the release
HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPT = os.path.join(HERE, 'journal-copy.py')
VECTORS = os.path.join(HERE, '..', '..', 'libs', 'log', 'test', 'mask-vectors.json')

spec = importlib.util.spec_from_file_location('journal_copy', SCRIPT)
jc = importlib.util.module_from_spec(spec)
spec.loader.exec_module(jc)


def entry(message, unit='konjir.service', pid='4242', **extra):
    return {'_PID': pid, '_SYSTEMD_UNIT': unit, 'MESSAGE': message, '__REALTIME_TIMESTAMP': '1761134400123456', **extra}


class Masking(unittest.TestCase):
    def test_shared_vectors(self):
        with open(VECTORS, encoding='utf-8') as f:
            vectors = json.load(f)
        for given, masked in vectors['text']:
            with self.subTest(given=given):
                self.assertEqual(jc.mask_text(given), masked)
        fields = {k: 'value' for k in vectors['secretFields'] + vectors['plainFields']}
        out = jc.mask_value(fields)
        for k in vectors['secretFields']:
            self.assertEqual((k, out[k]), (k, '***'))
        for k in vectors['plainFields']:
            self.assertEqual((k, out[k]), (k, 'value'))

    def test_a_caddy_line_is_masked_and_marked(self):
        line = json.loads(jc.line_of(entry(json.dumps({
            'level': 'error', 'logger': 'http.log.error', 'msg': 'dial tcp: connection refused',
            'request': {'uri': '/api/session/oauth/callback?code=kjc_abc123&state=zzz', 'headers': {'Cookie': ['REDACTED']}},
        }), unit='caddy.service', pid='77'), 'caddy'))
        self.assertEqual(line['request'], {'uri': '/api/session/oauth/callback?code=***&state=***', 'headers': {'Cookie': '***'}})
        self.assertEqual(line['_SYSTEMD_UNIT'], 'caddy.service')


class Lines(unittest.TestCase):
    def test_systemd_lines_carry_the_journals_pid_and_unit(self):
        line = json.loads(jc.line_of({'_PID': '1', 'UNIT': 'konjir.service', 'MESSAGE': 'konjir.service: Main process exited, code=killed, status=9/KILL'}, 'konjir'))
        self.assertEqual((line['_PID'], line['UNIT'], line['level']), ('1', 'konjir.service', 'notice'))
        # With no UNIT, the unit's own name.
        self.assertEqual(json.loads(jc.line_of({'_PID': '1', 'MESSAGE': 'x'}, 'konjir'))['UNIT'], 'konjir.service')

    def test_a_service_line_cannot_forge_the_trusted_fields(self):
        line = json.loads(jc.line_of(entry(json.dumps({'level': 'error', 'message': 'm', '_PID': '1', 'UNIT': 'konjir.service', '_SYSTEMD_UNIT': 'caddy.service', 'MESSAGE_ID': 'x'})), 'konjir'))
        self.assertEqual(line, {'level': 'error', 'message': 'm', '_SYSTEMD_UNIT': 'konjir.service'})

    def test_a_line_that_isnt_json_is_masked_and_loses_forged_fields(self):
        for raw in ('{"level":"error","_SYSTEMD_UNIT":"konjir.service","_PID": "1"} and more kjs_secret1',
                    'Error: bad input "UNIT":"konjir.service", _PID=1 MESSAGE_ID: x kjs_secret1'):
            with self.subTest(raw=raw):
                line = jc.line_of(entry(raw), 'konjir')
                for forged in ('_PID', 'UNIT', 'MESSAGE_ID', 'secret1'):
                    self.assertNotIn(forged, line)
        # A JSON line after a space is still parsed, and loses them as JSON.
        line = json.loads(jc.line_of(entry(' {"level":"error","_PID":"1","UNIT":"konjir.service","message":"m"}'), 'konjir'))
        self.assertEqual(line, {'level': 'error', 'message': 'm', '_SYSTEMD_UNIT': 'konjir.service'})

    def test_a_null_or_empty_message_ships_nothing(self):
        self.assertIsNone(jc.line_of(entry(None), 'konjir'))
        self.assertIsNone(jc.line_of(entry('  '), 'konjir'))

    def test_a_long_dead_job_line_is_capped_and_still_counts(self):
        error = 'Error: cascade failed kjs_tok123 ' + 'x' * 40000 + '\n    at frame\n' * 200
        raw = json.dumps({'time': 't', 'level': 'error', 'message': 'outbox job cascade for version v1 is dead after 10 failed attempts',
                          'event': 'outbox_job_dead', 'id': '42', 'kolab': 'kolab', 'attempts': 10, 'error': error})
        self.assertGreater(len(raw), 40000)
        line = jc.line_of(entry(raw), 'konjir')
        self.assertLessEqual(len(line.encode('utf-8')), jc.MAX_LINE)
        parsed = json.loads(line)
        self.assertEqual((parsed['level'], parsed['event'], parsed['id'], parsed['_SYSTEMD_UNIT'], parsed['truncated']), ('error', 'outbox_job_dead', '42', 'konjir.service', True))
        self.assertTrue(parsed['error'].startswith('Error: cascade failed kjs_*** '))
        self.assertTrue(parsed['error'].endswith(jc.TRUNCATED))

    def test_a_json_line_of_many_fields_is_capped(self):
        raw = json.dumps({'level': 'error', 'event': 'http_5xx', **{f'f{i}': 'y' * 60 for i in range(1000)}})
        parsed = json.loads(jc.line_of(entry(raw), 'konjir'))
        self.assertEqual((parsed['level'], parsed['event'], parsed['truncated']), ('error', 'http_5xx', True))

    def test_a_long_text_line_is_capped(self):
        line = jc.line_of(entry('é' * 20000), 'konjir')
        self.assertLessEqual(len(line.encode('utf-8')), jc.MAX_LINE)
        self.assertTrue(line.endswith(jc.TRUNCATED))

    def test_deeply_nested_json_is_shipped_as_text_not_a_crash(self):
        raw = '{"a":' * 50000 + '1' + '}' * 50000
        line = jc.line_of(entry(raw), 'konjir')
        self.assertLessEqual(len(line.encode('utf-8')), jc.MAX_LINE)


class Copy(unittest.TestCase):
    def test_the_copy_skips_its_probes_and_ships_the_rest(self):
        entries = [
            {'_PID': '900', '_UID': '0', 'MESSAGE': 'konjir-journal@konjir: probe', 'KONJIR_JOURNAL_PROBE': '1', 'OBJECT_SYSTEMD_UNIT': 'konjir.service'},
            entry('{"level":"info","message":"hello"}'),
            entry(None),
        ]
        with tempfile.TemporaryDirectory() as d:
            out = os.path.join(d, 'konjir.log')
            stdin = ''.join(json.dumps(e) + '\n' for e in entries) + '[1, 2]\nnot json\n'
            r = subprocess.run([sys.executable, SCRIPT, 'konjir', out, '--stdin'], input=stdin.encode(), capture_output=True, timeout=30)
            self.assertEqual(r.returncode, 0, r.stderr)
            with open(out, encoding='utf-8') as f:
                self.assertEqual([json.loads(l) for l in f], [{'level': 'info', 'message': 'hello', '_SYSTEMD_UNIT': 'konjir.service'}])

    def test_a_heartbeat_says_how_old_the_last_journal_line_is(self):
        beat = json.loads(jc.heartbeat('caddy', 1761134400.5, 312.7))
        self.assertEqual((beat['event'], beat['unit'], beat['level'], beat['journal_age_s'], beat['last_journal_line']),
                         ('heartbeat', 'caddy.service', 'info', 312, '2025-10-22T12:00:00.500Z'))


if __name__ == '__main__':
    unittest.main()
