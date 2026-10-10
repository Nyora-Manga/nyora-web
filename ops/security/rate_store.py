"""Atomic fixed-window budgets shared by every worker; no account data stored."""
from contextlib import closing
import hashlib
import ipaddress
import math
import os
import sqlite3
import time


def client_key(value):
    address = ipaddress.ip_address(value)
    if address.version == 6:
        if address.ipv4_mapped:
            return str(address.ipv4_mapped)
        return str(ipaddress.ip_network(f'{address}/64', strict=False))
    return str(address)


class RateStore:
    def __init__(self, path):
        self.path = str(path)
        with closing(self.connect()) as conn, conn:
            conn.execute('CREATE TABLE IF NOT EXISTS budgets (key TEXT PRIMARY KEY, expires REAL NOT NULL, hits INTEGER NOT NULL)')
            conn.execute('CREATE INDEX IF NOT EXISTS budget_expiry ON budgets(expires)')
        os.chmod(self.path, 0o600)

    def connect(self):
        return sqlite3.connect(self.path, timeout=2)

    def hit(self, scope, identity, limit, window, now=None):
        now = time.time() if now is None else now
        key = hashlib.sha256(f'{scope}\0{identity}'.encode()).hexdigest()
        with closing(self.connect()) as conn, conn:
            conn.execute('BEGIN IMMEDIATE')
            conn.execute('DELETE FROM budgets WHERE expires <= ?', (now,))
            row = conn.execute('SELECT expires, hits FROM budgets WHERE key = ?', (key,)).fetchone()
            if row:
                expires, hits = row
                if hits >= limit:
                    return max(1, math.ceil(expires - now))
                conn.execute('UPDATE budgets SET hits=hits+1 WHERE key=?', (key,))
            else:
                if conn.execute('SELECT count(*) FROM budgets').fetchone()[0] >= 50000:
                    raise sqlite3.OperationalError('Rate store capacity reached')
                conn.execute('INSERT INTO budgets VALUES (?,?,1)', (key, now + window))
        return 0
