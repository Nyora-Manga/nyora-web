"""Auth budgets shared by gunicorn workers. Install as app/ratelimit.py.

The service binds to loopback. Caddy OVERWRITES X-Nyora-Client-IP from its
trusted-proxy client_ip value; public X-Forwarded-For / X-Real-IP are ignored.
"""
import os
import sqlite3
from fastapi import HTTPException, Request
from starlette.concurrency import run_in_threadpool
from .rate_store import RateStore, client_key

store = RateStore(os.environ.get('NYORA_RATE_DB', '/home/ubuntu/nyora-sync-server/rate-limits.sqlite3'))


def client_ip(request):
    try:
        # Never trust arbitrary public forwarding headers. A missing proxy
        # identity shares one restrictive bucket (including local probes).
        return client_key(request.headers.get('x-nyora-client-ip', '127.0.0.1'))
    except ValueError:
        return 'unknown'


def rate_limit(limit, window, scope):
    async def dependency(request: Request):
        try:
            retry = await run_in_threadpool(store.hit, scope, client_ip(request), limit, window)
        except (sqlite3.Error, OSError):
            raise HTTPException(503, 'Authentication temporarily unavailable.', headers={'Retry-After': '5'})
        if retry:
            raise HTTPException(429, 'Too many requests. Please slow down.', headers={'Retry-After': str(retry), 'Cache-Control': 'no-store'})
    return dependency


login_rate_limit = rate_limit(int(os.environ.get('NYORA_LOGIN_RATE', '20')), 300, 'login')
register_rate_limit = rate_limit(int(os.environ.get('NYORA_REGISTER_RATE', '10')), 3600, 'register')
